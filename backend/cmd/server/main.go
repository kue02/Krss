package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"krss/backend/internal/config"
	"krss/backend/internal/db"
	"krss/backend/internal/handler"
	transport "krss/backend/internal/http"
	"krss/backend/internal/repository"
	"krss/backend/internal/scheduler"
	"krss/backend/internal/service"
	"krss/backend/internal/service/ai"
	"krss/backend/internal/service/anubis"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
	"krss/backend/pkg/snowflake"
)

// @title Krss API
// @version 1.0
// @description This is a modern RSS reader API.
// @BasePath /api
func main() {
	cfg := config.Load()

	logger.Init(logger.ParseLevel(cfg.LogLevel))

	if err := snowflake.Init(1); err != nil {
		logger.Error("init snowflake", "error", err)
		os.Exit(1)
	}

	dbConn, err := db.Open(cfg.DBPath)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer dbConn.Close()

	folderRepo := repository.NewFolderRepository(dbConn)
	feedRepo := repository.NewFeedRepository(dbConn)
	entryRepo := repository.NewEntryRepository(dbConn)
	settingsRepo := repository.NewSettingsRepository(dbConn)
	aiSummaryRepo := repository.NewAISummaryRepository(dbConn)
	aiTranslationRepo := repository.NewAITranslationRepository(dbConn)
	aiListTranslationRepo := repository.NewAIListTranslationRepository(dbConn)
	domainRateLimitRepo := repository.NewDomainRateLimitRepository(dbConn)
	filterRepo := repository.NewFilterRepository(dbConn)
	mcpServerRepo := repository.NewMCPServerRepository(dbConn)

	// Initialize rate limiter with stored setting
	initialRateLimit := ai.DefaultRateLimit
	if setting, err := settingsRepo.Get(context.Background(), "ai.rate_limit"); err == nil && setting != nil {
		var val int
		fmt.Sscanf(setting.Value, "%d", &val)
		if val > 0 {
			initialRateLimit = val
		}
	}
	rateLimiter := ai.NewRateLimiter(initialRateLimit)

	settingsService := service.NewSettingsService(settingsRepo, rateLimiter)

	// 代理按来源生效（14 批）：解析「订阅 → 文件夹父级链 → 全局」的生效代理。
	// 先建它，再装到 ClientFactory 上 —— 抓取/图标/正文/免费翻译都按来源取。
	// 50 批 2.2：智能档的域记忆（proxy_domain_memory，迁移 29）接给两边 ——
	// 解析器用它编码 smart: 前缀，传输层用它学习/查询。
	domainMemoryRepo := repository.NewProxyDomainMemoryRepository(dbConn)
	proxySourceService := service.NewProxySourceService(feedRepo, folderRepo, settingsService).WithDomainMemory(domainMemoryRepo)

	// Initialize client factory for proxy and IP stack support
	clientFactory := network.NewClientFactory(settingsService, settingsService).WithSourceProxy(proxySourceService).WithDomainMemory(newNetworkDomainMemory(domainMemoryRepo))

	// Initialize Anubis solver for bypassing Anubis protection
	anubisStore := anubis.NewStore(settingsRepo)
	anubisSolver := anubis.NewSolver(clientFactory, anubisStore)

	iconService := service.NewIconService(cfg.DataDir, feedRepo, clientFactory, anubisSolver)

	// Backfill icons for existing feeds (run in background)
	backfillCtx, cancelBackfill := context.WithCancel(context.Background())
	var backfillWG sync.WaitGroup
	backfillWG.Add(1)
	go func() {
		defer backfillWG.Done()
		if err := iconService.BackfillIcons(backfillCtx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("backfill icons", "error", err)
		}
	}()

	folderService := service.NewFolderService(folderRepo, feedRepo)
	// 规则引擎：抓取入库之后跑，只改条目上的标记（muted / read / starred / auto-translate）。
	// 本项目有两条入库路径（新订阅首次抓取、刷新），两条都要过规则，所以先建它再注入。
	// AI 与 webhook 是 P2/P3 动作的依赖：AI 供「AI 条件」与「自然语言建规则」，
	// webhook 用统一的网络层（继承代理设置）出网投递（所以 aiService 得先于它建好）。
	aiService := service.NewAIServiceWithFeedContext(aiSummaryRepo, aiTranslationRepo, aiListTranslationRepo, settingsRepo, rateLimiter, entryRepo, feedRepo, clientFactory)
	webhookClient := clientFactory.NewHTTPClient(context.Background(), 15*time.Second)
	// 推送通道（Bark）：与 webhook 共用同一套「POST JSON 出网」语义，只是 UA 不同便于分辨
	notifyService := service.NewNotifyService(settingsRepo, service.NewHTTPNotifier(webhookClient))
	filterService := service.NewFilterService(service.FilterServiceDeps{
		Filters: filterRepo,
		Entries: entryRepo,
		Feeds:   feedRepo,
		Folders: folderRepo,
		AI:      aiService,
		Webhook: service.NewHTTPWebhookSender(webhookClient),
		Notify:  notifyService,
	})
	// MCP（16 批入向 / 17 批出向）共用同一套协议底座 internal/service/mcp。
	mcpService := service.NewMCPService(mcpServerRepo, settingsService, clientFactory, aiService)
	feedService := service.NewFeedService(feedRepo, folderRepo, entryRepo, iconService, settingsService, clientFactory, anubisSolver, filterService, mcpService)
	// 条目列表要能按「保存筛选视图」（filters.kind = view）筛，所以 entryService 也拿到 filterRepo
	entryService := service.NewEntryService(entryRepo, feedRepo, folderRepo, filterRepo)
	readabilityService := service.NewReadabilityService(entryRepo, clientFactory, anubisSolver)
	domainRateLimitService := service.NewDomainRateLimitService(domainRateLimitRepo)
	refreshService := service.NewRefreshService(feedRepo, entryRepo, settingsService, iconService, clientFactory, anubisSolver, domainRateLimitService, filterService, mcpService)
	opmlService := service.NewOPMLService(folderService, feedService, refreshService, iconService, folderRepo, feedRepo)

	// 代理媒体磁盘缓存（50-2）：图片/音视频取过一次就落盘，第二次起不再出网。
	// 缓存在 $KRSS_DATA_DIR/proxy-cache，上限可用 KRSS_MEDIA_CACHE_MB 调（默认 512MB）。
	proxyService := service.NewProxyService(clientFactory, anubisSolver).
		WithMediaCache(filepath.Join(cfg.DataDir, "proxy-cache"), mediaCacheBytes())
	authService := service.NewAuthService(settingsRepo)

	folderHandler := handler.NewFolderHandler(folderService, proxySourceService)
	feedHandler := handler.NewFeedHandler(feedService, refreshService, proxySourceService)
	entryHandler := handler.NewEntryHandler(entryService, readabilityService)
	importTaskService := service.NewImportTaskService()
	opmlHandler := handler.NewOPMLHandler(opmlService, importTaskService)
	iconHandler := handler.NewIconHandler(iconService)
	proxyHandler := handler.NewProxyHandler(proxyService)
	settingsHandler := handler.NewSettingsHandler(settingsService, clientFactory, proxySourceService)
	proxySourceHandler := handler.NewProxySourceHandler(proxySourceService)
	aiHandler := handler.NewAIHandler(aiService)
	authHandler := handler.NewAuthHandler(authService)
	domainRateLimitHandler := handler.NewDomainRateLimitHandler(domainRateLimitService)
	filterHandler := handler.NewFilterHandler(filterService)
	mcpOutboundService := service.NewMCPOutboundService(settingsRepo, entryService, feedRepo, folderRepo)
	mcpHandler := handler.NewMCPHandler(mcpService, mcpOutboundService)
	mcpEndpointHandler := handler.NewMCPEndpointHandler(mcpOutboundService)

	router := transport.NewRouter(folderHandler, feedHandler, entryHandler, opmlHandler, iconHandler, proxyHandler, settingsHandler, aiHandler, authHandler, domainRateLimitHandler, filterHandler, proxySourceHandler, mcpHandler, mcpEndpointHandler, authService, cfg.StaticDir, cfg.EnableSwagger)
	pprofServer := startPprofServer(cfg.PprofAddr)

	// 定时刷新：间隔来自设置（设置 → 高级 → 拉取），每轮重新读一次 —— 改完下一轮生效，不用重启
	sched := scheduler.New(refreshService, func() time.Duration {
		fs, err := settingsService.GetFetchSettings(context.Background())
		if err != nil || fs == nil || fs.IntervalMinutes <= 0 {
			return 15 * time.Minute
		}
		return time.Duration(fs.IntervalMinutes) * time.Minute
	})
	sched.Start()

	// Handle graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down...")

		// Create a deadline for shutdown
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		sched.Stop()
		readabilityService.Close()
		proxyService.Close()
		cancelBackfill()

		// Wait for backfill task to exit within shutdown deadline.
		backfillDone := make(chan struct{})
		go func() {
			backfillWG.Wait()
			close(backfillDone)
		}()
		select {
		case <-backfillDone:
		case <-ctx.Done():
			logger.Warn("backfill stop timeout")
		}

		if pprofServer != nil {
			if err := pprofServer.Shutdown(ctx); err != nil {
				logger.Error("pprof shutdown", "module", "server", "action", "shutdown", "resource", "pprof", "result", "failed", "error", err)
			}
		}
		// Gracefully shutdown the HTTP server
		if err := router.Shutdown(ctx); err != nil {
			logger.Error("server shutdown", "error", err)
		}
	}()

	if err := router.Start(cfg.Addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("start server", "error", err)
		os.Exit(1)
	}

	logger.Info("server stopped")
}

func startPprofServer(addr string) *http.Server {
	if addr == "" {
		return nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("pprof server started", "module", "server", "action", "start", "resource", "pprof", "result", "ok", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("pprof server failed", "module", "server", "action", "start", "resource", "pprof", "result", "failed", "addr", addr, "error", err)
		}
	}()

	return server
}

// mediaCacheBytes 代理媒体缓存上限（KB→B），KRSS_MEDIA_CACHE_MB 可覆盖，默认 512MB。
func mediaCacheBytes() int64 {
	mb := int64(512)
	if raw := os.Getenv("KRSS_MEDIA_CACHE_MB"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			mb = parsed
		}
	}
	return mb << 20
}

// newNetworkDomainMemory 把仓储层的域记忆适配成 pkg/network 的形状（50 批 2.2）。
// 读写失败都不外抛：记忆只是优化，不能因为它影响抓取。
type networkDomainMemoryAdapter struct {
	repo repository.ProxyDomainMemoryRepository
}

func newNetworkDomainMemory(repo repository.ProxyDomainMemoryRepository) network.DomainMemory {
	return &networkDomainMemoryAdapter{repo: repo}
}

func (a *networkDomainMemoryAdapter) MemoryModeFor(ctx context.Context, host string) (string, bool) {
	m, err := a.repo.Get(ctx, host)
	if err != nil || m == nil {
		return "", false
	}
	return m.Mode, true
}

func (a *networkDomainMemoryAdapter) Remember(ctx context.Context, host, mode string) {
	if err := a.repo.Set(ctx, host, mode); err != nil {
		logger.Warn("proxy domain memory write failed", "module", "network", "action", "remember", "resource", "smart-proxy", "host", host, "error", err)
	}
}
