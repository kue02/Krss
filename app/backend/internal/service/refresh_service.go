//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mmcdole/gofeed"
	"golang.org/x/sync/semaphore"

	"gist/backend/internal/config"
	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/pkg/logger"
	"gist/backend/pkg/network"
)

// refreshTimeout / maxConcurrentRefresh / maxConcurrentPerHost 是**默认值**，
// 实际取值走 设置 → 高级 的「拉取」四项（每轮刷新开始时读一次，改完下一轮生效）。
// 历史：超时 30s→15s（健康源 1~3s 就回，极少数冷缓存/被限流的源会一路挂到超时，
// 5、6 个这样的源就把整轮拖到 2 分钟）；同主机并发 1→6（自己的 RSSHub 上挂几十个源时，
// 串行等于把最慢几个源的耗时相加：实测 79 源串行 >15min，3 → 25~45s）。
const refreshTimeout = DefaultRefreshTimeoutSeconds * time.Second

const (
	maxConcurrentRefresh = DefaultRefreshConcurrency
	maxConcurrentPerHost = DefaultRefreshPerHostConcurrency
)

// fetchRuntimeConfig 一轮刷新用的运行参数快照（来自设置）。
type fetchRuntimeConfig struct {
	Concurrency        int
	PerHostConcurrency int
	Timeout            time.Duration
}

// defaultFetchRuntime 设置读不到时的兜底（与编译期默认值一致）。
func defaultFetchRuntime() fetchRuntimeConfig {
	return fetchRuntimeConfig{
		Concurrency:        maxConcurrentRefresh,
		PerHostConcurrency: maxConcurrentPerHost,
		Timeout:            refreshTimeout,
	}
}

// loadFetchRuntime 从设置读一次运行参数；读失败就用默认值（不因为设置读失败而刷不了）。
func (s *refreshService) loadFetchRuntime(ctx context.Context) fetchRuntimeConfig {
	cfg := defaultFetchRuntime()
	if s.settings == nil {
		return cfg
	}
	fs, err := s.settings.GetFetchSettings(ctx)
	if err != nil || fs == nil {
		if err != nil {
			logger.Warn("load fetch settings failed, using defaults", "module", "service", "action", "get", "resource", "settings", "result", "failed", "error", err)
		}
		return cfg
	}
	if fs.Concurrency > 0 {
		cfg.Concurrency = fs.Concurrency
	}
	if fs.PerHostConcurrency > 0 {
		cfg.PerHostConcurrency = fs.PerHostConcurrency
	}
	if fs.TimeoutSeconds > 0 {
		cfg.Timeout = time.Duration(fs.TimeoutSeconds) * time.Second
	}
	s.mu.Lock()
	s.fetchCfg = cfg
	s.mu.Unlock()
	return cfg
}

// fetchRuntime 取当前运行参数；从没加载过（比如单源刷新入口）就先读一次设置。
func (s *refreshService) fetchRuntime(ctx context.Context) fetchRuntimeConfig {
	s.mu.Lock()
	cfg := s.fetchCfg
	s.mu.Unlock()
	if cfg.Concurrency == 0 || cfg.Timeout == 0 {
		return s.loadFetchRuntime(ctx)
	}
	return cfg
}

// hostRateLimiter manages per-host concurrency and rate limits.
type hostRateLimiter struct {
	mu          sync.Mutex
	semaphores  map[string]*semaphore.Weighted
	lastRequest map[string]time.Time
	getInterval func(host string) time.Duration
	// perHost 同主机并发上限（来自设置，构造时传入）
	perHost int
}

func newHostRateLimiter(getInterval func(host string) time.Duration, perHost int) *hostRateLimiter {
	if perHost <= 0 {
		perHost = maxConcurrentPerHost
	}
	return &hostRateLimiter{
		semaphores:  make(map[string]*semaphore.Weighted),
		lastRequest: make(map[string]time.Time),
		getInterval: getInterval,
		perHost:     perHost,
	}
}

// acquireSemaphore acquires the per-host semaphore to ensure serial execution for the same host.
// This does NOT occupy global concurrency slots, allowing different hosts to queue in parallel.
func (h *hostRateLimiter) acquireSemaphore(ctx context.Context, host string) error {
	h.mu.Lock()
	sem, ok := h.semaphores[host]
	if !ok {
		sem = semaphore.NewWeighted(int64(h.perHost))
		h.semaphores[host] = sem
	}
	h.mu.Unlock()

	return sem.Acquire(ctx, 1)
}

// releaseSemaphore releases the per-host semaphore.
func (h *hostRateLimiter) releaseSemaphore(host string) {
	h.mu.Lock()
	if sem, ok := h.semaphores[host]; ok {
		sem.Release(1)
	}
	h.mu.Unlock()
}

// waitForInterval waits until the configured interval has passed since the last request.
// This should be called AFTER acquiring the per-host semaphore to ensure serial waiting.
func (h *hostRateLimiter) waitForInterval(ctx context.Context, host string, force bool) error {
	if force {
		return nil
	}
	interval := h.getInterval(host)
	if interval <= 0 {
		return nil
	}

	h.mu.Lock()
	lastReq, exists := h.lastRequest[host]
	h.mu.Unlock()

	if exists {
		elapsed := time.Since(lastReq)
		if elapsed < interval {
			waitTime := interval - elapsed
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(waitTime):
			}
		}
	}
	return nil
}

// recordRequest records the current time as the last request time for the host.
func (h *hostRateLimiter) recordRequest(host string) {
	h.mu.Lock()
	h.lastRequest[host] = time.Now()
	h.mu.Unlock()
}

// processParsedFeed handles the common logic after successfully parsing a feed.
// It clears error messages, updates ETag/LastModified, saves entries, and fetches icons.
func (s *refreshService) processParsedFeed(ctx context.Context, feed model.Feed, parsed *gofeed.Feed, resp *http.Response) error {
	// Clear error message on successful refresh
	feed.ErrorMessage = nil
	_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, nil)

	// Update feed ETag and LastModified (only update non-empty values)
	newETag := strings.TrimSpace(resp.Header.Get("ETag"))
	newLastModified := strings.TrimSpace(resp.Header.Get("Last-Modified"))
	if newETag != "" || newLastModified != "" {
		if newETag != "" {
			feed.ETag = &newETag
		}
		if newLastModified != "" {
			feed.LastModified = &newLastModified
		}
		if _, err := s.feeds.Update(ctx, feed); err != nil {
			logger.Warn("update feed etag failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "error", err)
		}
	}

	// Save entries
	newCount, updatedCount, newEntries := s.saveEntries(ctx, feed.ID, parsed.Items)
	s.recordFeedResult(RefreshFeedResult{
		FeedID:   feed.ID,
		Title:    feed.Title,
		IconPath: iconPathOf(feed),
		New:      newCount,
		Updated:  updatedCount,
	})
	if newCount > 0 || updatedCount > 0 {
		logger.Info("feed refreshed", "module", "service", "action", "refresh", "resource", "feed", "result", "ok", "feed_id", feed.ID, "feed_title", feed.Title, "new", newCount, "updated", updatedCount)
	}

	// 规则引擎挂在入库之后：只对本次新增的条目按顺序跑一遍（首个命中即停），只改标记。
	// 仅新条目生效 —— 已存在的条目走更新分支时不回头改，避免「刷新一次就被追改一遍」。
	if len(newEntries) > 0 && s.filters != nil {
		if applied, err := s.filters.ApplyToEntries(ctx, feed, newEntries); err != nil {
			logger.Warn("apply filters failed", "module", "service", "action", "apply", "resource", "filter", "result", "failed", "feed_id", feed.ID, "error", err)
		} else if applied > 0 {
			logger.Info("filters applied on new entries", "module", "service", "action", "apply", "resource", "filter", "result", "ok", "feed_id", feed.ID, "applied", applied)
		}
	}

	// Backfill siteURL if empty (for feeds added before siteURL was implemented)
	if (feed.SiteURL == nil || *feed.SiteURL == "") && parsed.Link != "" {
		newSiteURL := strings.TrimSpace(parsed.Link)
		if newSiteURL != "" {
			_ = s.feeds.UpdateSiteURL(ctx, feed.ID, newSiteURL)
			feed.SiteURL = &newSiteURL
		}
	}

	// Fetch icon if feed doesn't have one
	if s.icons != nil && (feed.IconPath == nil || *feed.IconPath == "") {
		imageURL := ""
		if parsed.Image != nil {
			imageURL = strings.TrimSpace(parsed.Image.URL)
		}
		siteURL := feed.URL
		if feed.SiteURL != nil && *feed.SiteURL != "" {
			siteURL = *feed.SiteURL
		}
		if iconPath, err := s.icons.FetchAndSaveIconForFeed(ctx, feed.ID, imageURL, siteURL); err == nil && iconPath != "" {
			_ = s.feeds.UpdateIconPath(ctx, feed.ID, iconPath)
		}
	}

	return nil
}

// saveEntries saves parsed feed items to the database.
// Returns the count of new and updated entries, plus the newly created ones
// （规则引擎只处理「刚入库的新条目」，因此把新条目一并回传）。
func (s *refreshService) saveEntries(ctx context.Context, feedID int64, items []*gofeed.Item) (newCount, updatedCount int, newEntries []model.Entry) {
	dynamicTime := hasDynamicTime(items)
	for _, item := range items {
		entry := itemToEntry(feedID, item, dynamicTime)
		if entry.URL == nil || *entry.URL == "" {
			continue
		}

		exists, err := s.entries.ExistsByHash(ctx, feedID, entry.Hash)
		if err != nil {
			logger.Warn("check entry exists failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "error", err)
			continue
		}
		if !exists {
			legacyExists, err := s.entries.ExistsByLegacyURL(ctx, feedID, *entry.URL, entry.Hash)
			if err != nil {
				logger.Warn("check legacy entry exists failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "error", err)
				continue
			}
			exists = legacyExists
		}

		if err := s.entries.CreateOrUpdate(ctx, entry); err != nil {
			logger.Warn("save entry failed", "module", "service", "action", "save", "resource", "entry", "result", "failed", "error", err)
			continue
		}

		if exists {
			updatedCount++
		} else {
			newCount++
			newEntries = append(newEntries, entry)
		}
	}
	return
}

var ErrAlreadyRefreshing = errors.New("refresh already in progress")

// RefreshStatus holds the current state of the feed refresh process.
type RefreshStatus struct {
	IsRefreshing    bool
	LastRefreshedAt *time.Time
	// Total / Completed 是本次刷新的进度（供界面显示「还剩几个源」用）。
	// 仅在刷新进行中有效，空闲时均为 0。
	Total     int
	Completed int
	// Trigger 最近一轮刷新是谁触发的：manual（点了刷新/强制拉取）或 auto（定时器）。
	// 用户 12-17：自动刷新的结果不要弹框，改记进「自动刷新历史」。
	Trigger string `json:"trigger,omitempty"`
}

type RefreshService interface {
	RefreshAll(ctx context.Context) error
	// ForceRefreshAll 强制拉取（用户 11-19）：忽略条件请求（etag/last-modified）与
	// 「同主机多久内不重复抓」的等待，整轮重抓。并发上限照旧（那是礼貌，不是过期判定）。
	ForceRefreshAll(ctx context.Context) error
	// RefreshAllAuto 定时器触发的一轮刷新（用户 12-17）：与手动的区别只在「来源」——
	// 前端据此决定「弹结果框」还是「记进自动刷新历史」。
	RefreshAllAuto(ctx context.Context) error
	// ForceRefreshFeeds 强制拉取指定订阅（同样的强制语义，范围由界面决定）。
	ForceRefreshFeeds(ctx context.Context, feedIDs []int64) error
	// LastRefreshResults 最近一轮刷新里每个订阅的结果（新/更新条数、失败原因）。
	LastRefreshResults() []RefreshFeedResult
	RefreshFeed(ctx context.Context, feedID int64) error
	RefreshFeeds(ctx context.Context, feedIDs []int64) error
	IsRefreshing() bool
	GetRefreshStatus() RefreshStatus
}

// RefreshFeedResult 单个订阅在一次刷新里的结果（用户 11-8：刷新完要能告诉用户「哪个订阅更新了多少条」）。
// New/Updated 只有在真跑过抓取时才有意义；Error 非空表示这个源这轮失败了。
type RefreshFeedResult struct {
	FeedID   int64  `json:"feedId"`
	Title    string `json:"title"`
	IconPath string `json:"iconPath,omitempty"`
	New      int    `json:"new"`
	Updated  int    `json:"updated"`
	Error    string `json:"error,omitempty"`
}

type refreshService struct {
	feeds           repository.FeedRepository
	entries         repository.EntryRepository
	settings        SettingsService
	icons           IconService
	clientFactory   *network.ClientFactory
	anubis          AnubisSolver
	rateLimitSvc    DomainRateLimitService
	filters         FilterService
	mu              sync.Mutex
	isRefreshing    bool
	lastRefreshedAt *time.Time
	progressTotal   int
	progressDone    int
	// lastResults：最近一次刷新（全量或按范围）里每个订阅的结果。前端刷新完拿它渲染结果弹框。
	lastResults []RefreshFeedResult
	// fetchCfg 本轮刷新的并发/超时快照（来自 设置 → 高级 → 拉取）
	fetchCfg fetchRuntimeConfig
	// lastTrigger 最近一轮刷新的来源（manual / auto）
	lastTrigger string
}

func NewRefreshService(feeds repository.FeedRepository, entries repository.EntryRepository, settings SettingsService, icons IconService, clientFactory *network.ClientFactory, anubisSolver AnubisSolver, rateLimitSvc DomainRateLimitService, filters FilterService) RefreshService {
	return &refreshService{
		feeds:         feeds,
		entries:       entries,
		settings:      settings,
		icons:         icons,
		clientFactory: clientFactory,
		anubis:        anubisSolver,
		rateLimitSvc:  rateLimitSvc,
		filters:       filters,
	}
}

func (s *refreshService) RefreshAll(ctx context.Context) error {
	s.mu.Lock()
	s.lastTrigger = "manual"
	s.mu.Unlock()
	return s.refreshAll(ctx, false)
}

// ForceRefreshAll 见接口注释。
func (s *refreshService) ForceRefreshAll(ctx context.Context) error {
	s.mu.Lock()
	s.lastTrigger = "manual"
	s.mu.Unlock()
	return s.refreshAll(ctx, true)
}

func (s *refreshService) RefreshAllAuto(ctx context.Context) error {
	s.mu.Lock()
	s.lastTrigger = "auto"
	s.mu.Unlock()
	return s.refreshAll(ctx, false)
}

func (s *refreshService) refreshAll(ctx context.Context, force bool) error {
	s.mu.Lock()
	if s.isRefreshing {
		s.mu.Unlock()
		return ErrAlreadyRefreshing
	}
	s.isRefreshing = true
	if s.lastTrigger == "" {
		s.lastTrigger = "manual"
	}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.isRefreshing = false
		s.mu.Unlock()
	}()

	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		logger.Error("refresh list feeds", "module", "service", "action", "list", "resource", "feed", "result", "failed", "error", err)
		return err
	}

	cfg := s.loadFetchRuntime(ctx)
	logger.Info("refresh started", "module", "service", "action", "refresh", "resource", "feed", "result", "ok", "count", len(feeds),
		"concurrency", cfg.Concurrency, "per_host_concurrency", cfg.PerHostConcurrency, "timeout_ms", cfg.Timeout.Milliseconds())
	s.resetRefreshProgress(len(feeds))
	s.resetRefreshResults()
	s.refreshFeedsWithRateLimit(ctx, feeds, force)
	logger.Info("refresh completed", "module", "service", "action", "refresh", "resource", "feed", "result", "ok", "count", len(feeds))

	now := time.Now()
	s.mu.Lock()
	s.lastRefreshedAt = &now
	s.mu.Unlock()

	return nil
}

func (s *refreshService) IsRefreshing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isRefreshing
}

// resetRefreshProgress 开始一次刷新前重置进度（供界面显示还剩几个源）。
func (s *refreshService) resetRefreshProgress(total int) {
	s.mu.Lock()
	s.progressTotal = total
	s.progressDone = 0
	s.mu.Unlock()
}

// recordRefreshedFeed 每刷完一个源（无论成功失败）进度加一。
func (s *refreshService) recordRefreshedFeed() {
	s.mu.Lock()
	s.progressDone++
	s.mu.Unlock()
}

func (s *refreshService) GetRefreshStatus() RefreshStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := RefreshStatus{
		IsRefreshing:    s.isRefreshing,
		LastRefreshedAt: s.lastRefreshedAt,
		Trigger:         s.lastTrigger,
	}
	if s.isRefreshing {
		status.Total = s.progressTotal
		status.Completed = s.progressDone
	}
	return status
}

func (s *refreshService) RefreshFeed(ctx context.Context, feedID int64) error {
	feed, err := s.feeds.GetByID(ctx, feedID)
	if err != nil {
		return err
	}
	return s.refreshFeedInternal(ctx, feed, false)
}

func (s *refreshService) RefreshFeeds(ctx context.Context, feedIDs []int64) error {
	s.mu.Lock()
	s.lastTrigger = "manual"
	s.mu.Unlock()
	return s.refreshFeeds(ctx, feedIDs, false)
}

// ForceRefreshFeeds 见接口注释。
func (s *refreshService) ForceRefreshFeeds(ctx context.Context, feedIDs []int64) error {
	s.mu.Lock()
	s.lastTrigger = "manual"
	s.mu.Unlock()
	return s.refreshFeeds(ctx, feedIDs, true)
}

func (s *refreshService) refreshFeeds(ctx context.Context, feedIDs []int64, force bool) error {
	if len(feedIDs) == 0 {
		return nil
	}

	// 与全量刷新共用同一把「正在刷新」闸门：范围刷新同样要占进度条、要写 lastRefreshedAt，
	// 否则前端轮询状态时看不到这次刷新，新增条目要等下一轮 15s 轮询才冒出来。
	s.mu.Lock()
	if s.isRefreshing {
		s.mu.Unlock()
		return ErrAlreadyRefreshing
	}
	s.isRefreshing = true
	s.mu.Unlock()

	defer func() {
		now := time.Now()
		s.mu.Lock()
		s.isRefreshing = false
		s.lastRefreshedAt = &now
		s.mu.Unlock()
	}()

	// Get all feeds by IDs in a single query
	feeds, err := s.feeds.GetByIDs(ctx, feedIDs)
	if err != nil {
		logger.Error("get feeds by ids", "module", "service", "action", "list", "resource", "feed", "result", "failed", "error", err)
		return err
	}

	if len(feeds) == 0 {
		return nil
	}

	// 按范围刷新同样「每轮重读设置」：只在全量刷新里读会让「改完下一轮生效」在
	// 单源/分类刷新上不成立（那份快照可能来自上一轮全量，设置改了半天还没生效）。
	cfg := s.loadFetchRuntime(ctx)
	s.resetRefreshProgress(len(feeds))
	s.resetRefreshResults()
	s.refreshFeedsWithRateLimit(ctx, feeds, force)
	logger.Info("refresh completed", "module", "service", "action", "refresh", "resource", "feed", "result", "ok", "scope", "partial", "count", len(feeds),
		"concurrency", cfg.Concurrency, "per_host_concurrency", cfg.PerHostConcurrency, "timeout_ms", cfg.Timeout.Milliseconds(), "force", force)
	return nil
}

// resetRefreshResults / recordFeedResult / LastRefreshResults：一轮刷新的每源结果
//（并发刷新时多个 goroutine 同时写，统一走 s.mu）。
func (s *refreshService) resetRefreshResults() {
	s.mu.Lock()
	s.lastResults = nil
	s.mu.Unlock()
}

func (s *refreshService) recordFeedResult(result RefreshFeedResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.lastResults {
		if s.lastResults[i].FeedID == result.FeedID {
			// 同一个源在一轮里只会写一次；重试路径再写就覆盖（保留最新一次）
			s.lastResults[i] = result
			return
		}
	}
	s.lastResults = append(s.lastResults, result)
}

// LastRefreshResults 最近一轮刷新的每源结果（拷贝一份出去，别让调用方拿到内部切片）。
func (s *refreshService) LastRefreshResults() []RefreshFeedResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]RefreshFeedResult, len(s.lastResults))
	copy(out, s.lastResults)
	return out
}

// iconPathOf 结果弹框要带订阅图标；没有图标就留空（前端退化成默认 RSS 图标）。
func iconPathOf(feed model.Feed) string {
	if feed.IconPath == nil {
		return ""
	}
	return *feed.IconPath
}

// refreshFeedsWithRateLimit refreshes multiple feeds with rate limiting and concurrency control.
func (s *refreshService) refreshFeedsWithRateLimit(ctx context.Context, feeds []model.Feed, force bool) {
	cfg := s.fetchRuntime(ctx)
	globalSem := semaphore.NewWeighted(int64(cfg.Concurrency))

	hl := newHostRateLimiter(func(host string) time.Duration {
		if s.rateLimitSvc != nil {
			return s.rateLimitSvc.GetIntervalDuration(ctx, host)
		}
		return 0
	}, cfg.PerHostConcurrency)

	var wg sync.WaitGroup
	for _, feed := range feeds {
		feed := feed
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer s.recordRefreshedFeed()

			host := network.ExtractHost(feed.URL)

			if host != "" {
				if err := hl.acquireSemaphore(ctx, host); err != nil {
					logger.Debug("refresh host acquire cancelled", "module", "service", "action", "refresh", "resource", "feed", "result", "cancelled", "host", host, "error", err)
					return
				}
				defer hl.releaseSemaphore(host)

				// 强制拉取时不等「同主机多久内不重复抓」——用户明确要求再来一次
				if err := hl.waitForInterval(ctx, host, force); err != nil {
					logger.Debug("refresh host wait cancelled", "module", "service", "action", "refresh", "resource", "feed", "result", "cancelled", "host", host, "error", err)
					return
				}
			}

			if err := globalSem.Acquire(ctx, 1); err != nil {
				logger.Debug("refresh global acquire cancelled", "module", "service", "action", "refresh", "resource", "feed", "result", "cancelled", "host", host, "error", err)
				return
			}
			defer globalSem.Release(1)

			if host != "" {
				hl.recordRequest(host)
			}

			if err := s.refreshFeedInternal(ctx, feed, force); err != nil {
				s.recordFeedResult(RefreshFeedResult{
					FeedID:   feed.ID,
					Title:    feed.Title,
					IconPath: iconPathOf(feed),
					Error:    err.Error(),
				})
				logger.Error("refresh feed failed", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "error", err)
			}
		}()
	}

	wg.Wait()
}

func (s *refreshService) refreshFeedInternal(ctx context.Context, feed model.Feed, force bool) error {
	return s.refreshFeedWithUA(ctx, feed, config.DefaultUserAgent, true, force)
}

func (s *refreshService) refreshFeedWithUA(ctx context.Context, feed model.Feed, userAgent string, allowFallback bool, force bool) error {
	return s.refreshFeedWithCookie(ctx, feed, userAgent, "", allowFallback, 0, force)
}

func (s *refreshService) refreshFeedWithCookie(ctx context.Context, feed model.Feed, userAgent string, cookie string, allowFallback bool, retryCount int, force bool) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feed.URL, nil)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}
	req.Header.Set("User-Agent", userAgent)

	// Add cached Anubis cookie if available
	if cookie == "" {
		host := network.ExtractHost(feed.URL)
		if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, host, req.Header); cachedCookie != "" {
			cookie = cachedCookie
		}
	}

	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	// Conditional GET（强制拉取时不带 —— 要的就是重新拿一份，不是 304）
	if !force && feed.ETag != nil && *feed.ETag != "" {
		req.Header.Set("If-None-Match", *feed.ETag)
	}
	if !force && feed.LastModified != nil && *feed.LastModified != "" {
		req.Header.Set("If-Modified-Since", *feed.LastModified)
	}

	// 抓取走这条订阅生效的代理（订阅 → 文件夹父级链 → 全局，每轮现读）
	httpClient := s.clientFactory.NewHTTPClientForFeed(ctx, feed.ID, s.fetchRuntime(ctx).Timeout)
	resp, err := httpClient.Do(req)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}
	defer resp.Body.Close()

	// Not modified, skip parsing but clear any previous error
	if resp.StatusCode == http.StatusNotModified {
		logger.Debug("feed not modified", "module", "service", "action", "refresh", "resource", "feed", "result", "skipped", "feed_id", feed.ID, "host", network.ExtractHost(feed.URL))
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, nil)
		// 没变更也要出现在刷新明细里（0 新增 / 0 更新）—— 否则结果弹框里会「缺几个源」让人以为漏刷了
		s.recordFeedResult(RefreshFeedResult{FeedID: feed.ID, Title: feed.Title, IconPath: iconPathOf(feed)})
		return nil
	}

	// On HTTP error, try fallback UA if available
	if resp.StatusCode >= http.StatusBadRequest && allowFallback && s.settings != nil {
		fallbackUA := s.settings.GetFallbackUserAgent(ctx)
		if fallbackUA != "" {
			logger.Warn("retrying with fallback ua", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "status_code", resp.StatusCode)
			return s.refreshFeedWithCookie(ctx, feed, fallbackUA, cookie, false, retryCount, force)
		}
	}

	if resp.StatusCode >= http.StatusBadRequest {
		logger.Error("feed http error", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "status_code", resp.StatusCode)
		errMsg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return nil
	}

	// Read body into memory for Anubis detection and RSS parsing
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}

	parser := gofeed.NewParser()
	parsed, parseErr := parser.Parse(bytes.NewReader(body))
	if parseErr != nil {
		newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, body, feed.URL, resp.Cookies(), req.Header.Clone(), retryCount)
		switch {
		case anubisErr == nil:
			// Retry with fresh client and same request fingerprint.
			return s.refreshFeedWithFreshClient(ctx, feed, userAgent, newCookie, retryCount+1, force)
		case errors.Is(anubisErr, errAnubisNotPage):
			// Not an Anubis page; keep original parse error handling.
		case errors.Is(anubisErr, errAnubisRejected):
			errMsg := "upstream rejected"
			_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
			return errors.New(errMsg)
		case errors.Is(anubisErr, errAnubisRetryExceeded):
			errMsg := fmt.Sprintf("anubis challenge persists after %d retries", retryCount)
			_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
			return errors.New(errMsg)
		default:
			errMsg := fmt.Sprintf("anubis solve failed: %v", anubisErr)
			_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
			return anubisErr
		}
		errMsg := parseErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return parseErr
	}

	return s.processParsedFeed(ctx, feed, parsed, resp)
}

// refreshFeedWithFreshClient creates a new http.Client to avoid connection reuse after Anubis
func (s *refreshService) refreshFeedWithFreshClient(ctx context.Context, feed model.Feed, userAgent string, cookie string, retryCount int, force bool) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feed.URL, nil)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	// Use fresh client to avoid connection reuse（仍按这条订阅生效的代理）
	freshClient := s.clientFactory.NewHTTPClientForFeed(ctx, feed.ID, s.fetchRuntime(ctx).Timeout)
	resp, err := freshClient.Do(req)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		logger.Error("feed http error", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "status_code", resp.StatusCode)
		errMsg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Error("feed refresh read failed", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "error", err)
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return err
	}

	newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, body, feed.URL, resp.Cookies(), req.Header.Clone(), retryCount)
	switch {
	case anubisErr == nil:
		return s.refreshFeedWithFreshClient(ctx, feed, userAgent, newCookie, retryCount+1, force)
	case errors.Is(anubisErr, errAnubisNotPage):
		// Not an Anubis page; continue normal parsing.
	case errors.Is(anubisErr, errAnubisRejected):
		errMsg := "upstream rejected"
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return errors.New(errMsg)
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		errMsg := fmt.Sprintf("anubis challenge persists after %d retries", retryCount)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return errors.New(errMsg)
	default:
		errMsg := fmt.Sprintf("anubis solve failed: %v", anubisErr)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return anubisErr
	}

	parser := gofeed.NewParser()
	parsed, parseErr := parser.Parse(bytes.NewReader(body))
	if parseErr != nil {
		errMsg := parseErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		return parseErr
	}

	return s.processParsedFeed(ctx, feed, parsed, resp)
}
