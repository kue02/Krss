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

// 抓取重试（22-4，用户：「要做重试」）。
// 瞬断（EOF / 超时 / 连接重置）和对端 5xx / 429 是 RSS 抓取的常态（本机日志里 503、
// Client.Timeout 都是成天出现的），失败一次就记一次连续失败太冤 —— 同一个源在同一轮里
// 最多试 fetchMaxAttempts 次，相邻两次之间按 fetchRetryBackoffs 退避。
// 注意：解析失败（parse error）不重试 —— 同一份 body 再解一遍结果一样，重试只是浪费。
const fetchMaxAttempts = 3

var fetchRetryBackoffs = []time.Duration{time.Second, 3 * time.Second}

// 连续失败降频（22-4，用户：「要做连续失败降频」）。
// backoffBase 失败 1 次后等多久再抓，每多连败一次翻一倍，顶到 backoffMax 封顶。
// 5min 起：默认 15min 一轮 ⇒ 连败 1~2 次还每轮都试（瞬断不惩罚），第 3 次起开始跳轮。
const (
	backoffBase = 5 * time.Minute
	backoffMax  = 6 * time.Hour
)

// backoffForFailCount 连败 n 次后要等多久才允许再抓（n<=0 返回 0）。
func backoffForFailCount(n int) time.Duration {
	if n <= 0 {
		return 0
	}
	backoff := backoffBase
	for i := 1; i < n && backoff < backoffMax; i++ {
		backoff *= 2
		if backoff > backoffMax {
			backoff = backoffMax
		}
	}
	return backoff
}

// shouldBackoffRefresh 这个源这轮要不要跳过（只用于定时刷新；手动刷新永远直接抓）。
func shouldBackoffRefresh(feed model.Feed, now time.Time) bool {
	if feed.RefreshFailCount <= 0 || feed.RefreshLastFailAt == nil {
		return false
	}
	return now.Before(feed.RefreshLastFailAt.Add(backoffForFailCount(feed.RefreshFailCount)))
}

// sleepContext 退避等待：ctx 取消就提前返回 false（调用方直接收手，不记额外失败）。
func sleepContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

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

	s.recordFeedSuccess(ctx, feed.ID)
	return nil
}

// saveEntries saves parsed feed items to the database.
// Returns the count of new and updated entries, plus the newly created ones
// （规则引擎只处理「刚入库的新条目」，因此把新条目一并回传）。
//
// 22-4：「更新」只数**内容真变了**的条目 —— 先按「入库会撞到的那一行」把旧值取出来，
// 比标题/链接/正文/缩略图/作者五项（已读态、发布时间不算：前者刷新不写，后者 COALESCE 本来就保留旧的）。
// 写还是照写（CreateOrUpdate 原样调，保证 legacy hash 升级与 updated_at 语义不变），变的只是计数口径。
func (s *refreshService) saveEntries(ctx context.Context, feedID int64, items []*gofeed.Item) (newCount, updatedCount int, newEntries []model.Entry) {
	dynamicTime := hasDynamicTime(items)
	for _, item := range items {
		entry := itemToEntry(feedID, item, dynamicTime)
		if entry.URL == nil || *entry.URL == "" {
			continue
		}

		old, err := s.entries.GetExistingEntry(ctx, feedID, entry.Hash, *entry.URL)
		if err != nil {
			logger.Warn("load existing entry failed", "module", "service", "action", "get", "resource", "entry", "result", "failed", "error", err)
			continue
		}

		if err := s.entries.CreateOrUpdate(ctx, entry); err != nil {
			logger.Warn("save entry failed", "module", "service", "action", "save", "resource", "entry", "result", "failed", "error", err)
			continue
		}

		if old == nil {
			newCount++
			newEntries = append(newEntries, entry)
		} else if !entryContentEqual(*old, entry) {
			updatedCount++
		}
	}
	return
}

// entryContentEqual 刷新口径下的「内容一样」：入库会重写的五项全等就算没变。
func entryContentEqual(oldEntry, newEntry model.Entry) bool {
	return strPtrEq(oldEntry.Title, newEntry.Title) &&
		strPtrEq(oldEntry.URL, newEntry.URL) &&
		strPtrEq(oldEntry.Content, newEntry.Content) &&
		strPtrEq(oldEntry.ThumbnailURL, newEntry.ThumbnailURL) &&
		strPtrEq(oldEntry.Author, newEntry.Author)
}

func strPtrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
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
// 22-4 起：Updated 只数内容真变了的条目（见 saveEntries）；Skipped 表示定时刷新里
// 因连续失败退避被跳过的源（手动刷新永远直接抓，不会有这一项）。
type RefreshFeedResult struct {
	FeedID   int64  `json:"feedId"`
	Title    string `json:"title"`
	IconPath string `json:"iconPath,omitempty"`
	New      int    `json:"new"`
	Updated  int    `json:"updated"`
	Error    string `json:"error,omitempty"`
	Skipped  bool   `json:"skipped,omitempty"`
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
	return s.refreshAll(ctx, false, false)
}

// ForceRefreshAll 见接口注释。
func (s *refreshService) ForceRefreshAll(ctx context.Context) error {
	s.mu.Lock()
	s.lastTrigger = "manual"
	s.mu.Unlock()
	return s.refreshAll(ctx, true, false)
}

func (s *refreshService) RefreshAllAuto(ctx context.Context) error {
	s.mu.Lock()
	s.lastTrigger = "auto"
	s.mu.Unlock()
	return s.refreshAll(ctx, false, true)
}

func (s *refreshService) refreshAll(ctx context.Context, force bool, auto bool) error {
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
	// 22-4：只有定时刷新走退避跳过 —— 手动是用户明确要看最新的，一个都不许跳。
	if auto {
		feeds = s.applyRefreshBackoff(feeds)
	}
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

// applyRefreshBackoff 定时刷新入口的退避过滤（22-4）。
// 返回本轮真正要抓的源；被跳过的当场记一条 Skipped 结果并推进度，
// 于是进度条总数不变、结果明细里也能看到「这个源这轮没抓」。
func (s *refreshService) applyRefreshBackoff(feeds []model.Feed) []model.Feed {
	now := time.Now()
	eligible := make([]model.Feed, 0, len(feeds))
	for _, feed := range feeds {
		if !shouldBackoffRefresh(feed, now) {
			eligible = append(eligible, feed)
			continue
		}
		next := feed.RefreshLastFailAt.Add(backoffForFailCount(feed.RefreshFailCount))
		logger.Info("feed refresh backed off", "module", "service", "action", "refresh", "resource", "feed", "result", "skipped",
			"feed_id", feed.ID, "feed_title", feed.Title, "fail_count", feed.RefreshFailCount, "next_retry", next.Format(time.RFC3339))
		s.recordFeedResult(RefreshFeedResult{
			FeedID:   feed.ID,
			Title:    feed.Title,
			IconPath: iconPathOf(feed),
			Skipped:  true,
		})
		s.recordRefreshedFeed()
	}
	return eligible
}

// recordFeedSuccess 抓取成功（拿到 200 解析入库，或 304 未变更）：清掉连续失败计数。
func (s *refreshService) recordFeedSuccess(ctx context.Context, feedID int64) {
	if err := s.feeds.ResetRefreshFailure(ctx, feedID); err != nil {
		logger.Warn("reset refresh failure failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", feedID, "error", err)
	}
}

// recordFeedFailure 抓取失败（重试用完还是不行）：连续失败 +1 并打时间戳。
func (s *refreshService) recordFeedFailure(ctx context.Context, feedID int64) {
	if err := s.feeds.RecordRefreshFailure(ctx, feedID, time.Now().UTC()); err != nil {
		logger.Warn("record refresh failure failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", feedID, "error", err)
	}
}

// resetRefreshResults / recordFeedResult / LastRefreshResults：一轮刷新的每源结果
// （并发刷新时多个 goroutine 同时写，统一走 s.mu）。
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

	// 22-4：同一轮里最多试 fetchMaxAttempts 次 —— 瞬断（transport error）与
	// 对端过载（429 / 5xx）值得等一会儿再试一次；两次之间按 fetchRetryBackoffs 退避。
	// GET 没有 body，重试直接复用同一个 req 就行。
	// 14 批：每一试都走这条订阅**实际生效**的代理（订阅 → 文件夹父级链 → 全局，每轮现读）。
	var resp *http.Response
	var fetchErr error
	for attempt := 0; attempt < fetchMaxAttempts; attempt++ {
		if attempt > 0 {
			backoff := fetchRetryBackoffs[attempt-1]
			if attempt-1 >= len(fetchRetryBackoffs) {
				backoff = fetchRetryBackoffs[len(fetchRetryBackoffs)-1]
			}
			logger.Warn("retrying feed fetch", "module", "service", "action", "refresh", "resource", "feed", "result", "retrying",
				"feed_id", feed.ID, "feed_title", feed.Title, "attempt", attempt+1, "backoff_ms", backoff.Milliseconds(), "last_error", fetchErr)
			if !sleepContext(ctx, backoff) {
				return ctx.Err()
			}
		}

		var r *http.Response
		var err error
		// 每试一次拿一个新的 client：连接复用在对端半死不活时反而会连着失败
		//（Anubis 那条路本来就是这么干的，见 refreshFeedWithFreshClient）；
		// 用 NewHTTPClientForFeed 而不是 NewHTTPClient —— 代理按来源生效（14 批）不能丢。
		r, err = s.clientFactory.NewHTTPClientForFeed(ctx, feed.ID, s.fetchRuntime(ctx).Timeout).Do(req)
		if err != nil {
			// 整轮被取消不算失败 —— 不然每次重启/超时都会给所有源各记一次连败
			if ctx.Err() != nil {
				return ctx.Err()
			}
			fetchErr = err
			continue
		}
		if r.StatusCode == http.StatusTooManyRequests || r.StatusCode >= http.StatusInternalServerError {
			_, _ = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
			fetchErr = fmt.Errorf("HTTP %d", r.StatusCode)
			continue
		}
		resp = r
		fetchErr = nil
		break
	}
	if fetchErr != nil || resp == nil {
		errMsg := fetchErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
		return fetchErr
	}
	defer resp.Body.Close()

	// Not modified, skip parsing but clear any previous error
	if resp.StatusCode == http.StatusNotModified {
		logger.Debug("feed not modified", "module", "service", "action", "refresh", "resource", "feed", "result", "skipped", "feed_id", feed.ID, "host", network.ExtractHost(feed.URL))
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, nil)
		s.recordFeedSuccess(ctx, feed.ID)
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
		s.recordFeedFailure(ctx, feed.ID)
		return nil
	}

	// Read body into memory for Anubis detection and RSS parsing
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
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
			s.recordFeedFailure(ctx, feed.ID)
			return errors.New(errMsg)
		case errors.Is(anubisErr, errAnubisRetryExceeded):
			errMsg := fmt.Sprintf("anubis challenge persists after %d retries", retryCount)
			_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
			s.recordFeedFailure(ctx, feed.ID)
			return errors.New(errMsg)
		default:
			errMsg := fmt.Sprintf("anubis solve failed: %v", anubisErr)
			_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
			s.recordFeedFailure(ctx, feed.ID)
			return anubisErr
		}
		errMsg := parseErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
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
		s.recordFeedFailure(ctx, feed.ID)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		logger.Error("feed http error", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "status_code", resp.StatusCode)
		errMsg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Error("feed refresh read failed", "module", "service", "action", "refresh", "resource", "feed", "result", "failed", "feed_id", feed.ID, "feed_title", feed.Title, "error", err)
		errMsg := err.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
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
		s.recordFeedFailure(ctx, feed.ID)
		return errors.New(errMsg)
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		errMsg := fmt.Sprintf("anubis challenge persists after %d retries", retryCount)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
		return errors.New(errMsg)
	default:
		errMsg := fmt.Sprintf("anubis solve failed: %v", anubisErr)
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
		return anubisErr
	}

	parser := gofeed.NewParser()
	parsed, parseErr := parser.Parse(bytes.NewReader(body))
	if parseErr != nil {
		errMsg := parseErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, feed.ID, &errMsg)
		s.recordFeedFailure(ctx, feed.ID)
		return parseErr
	}

	return s.processParsedFeed(ctx, feed, parsed, resp)
}
