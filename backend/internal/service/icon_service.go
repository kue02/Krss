//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mmcdole/gofeed"
	"golang.org/x/net/html"
	"golang.org/x/sync/errgroup"

	"krss/backend/internal/config"
	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

const (
	iconTimeout        = 30 * time.Second
	maxConcurrentIcons = 4 // Concurrent icon fetch limit

	// 25-2：站点首页 HTML 只用来找 <link rel="icon"> 声明的图标，给它一个更短的超时 ——
	// 这条兜底不该把整轮回填拖住（拿不到就直接落到 Google / DuckDuckGo）。
	htmlIconTimeout = 10 * time.Second
	// 首页最多读这么多字节再解析（图标声明都在 <head> 里）
	htmlIconScanBytes = 512 * 1024
)

type IconService interface {
	// FetchAndSaveIcon downloads and saves the icon locally
	// Returns relative path like "example.com.ico" or "example.com.png" based on domain and detected format
	FetchAndSaveIcon(ctx context.Context, feedImageURL, siteURL string) (string, error)
	// FetchAndSaveIconForFeed 同上，但按这条订阅生效的代理出网（订阅 → 文件夹父级链 → 全局）
	FetchAndSaveIconForFeed(ctx context.Context, feedID int64, feedImageURL, siteURL string) (string, error)
	// EnsureIcon checks if the icon file exists, re-downloads if missing
	EnsureIcon(ctx context.Context, iconPath, siteURL string) error
	// EnsureIconForFeed 同上，但按这条订阅生效的代理出网
	EnsureIconForFeed(ctx context.Context, feedID int64, iconPath, siteURL string) error
	// EnsureIconByFeedID checks if icon exists, fetches feed's siteURL and re-downloads if missing
	EnsureIconByFeedID(ctx context.Context, feedID int64, iconPath string) error
	// BackfillIcons fetches icons for all feeds that don't have one
	BackfillIcons(ctx context.Context) error
	// GetIconPath returns the full path for an icon file
	GetIconPath(filename string) string
	// ClearAllIcons deletes all icon files and clears icon_path in database
	ClearAllIcons(ctx context.Context) (int64, error)
}

type iconService struct {
	dataDir       string
	feeds         repository.FeedRepository
	clientFactory *network.ClientFactory
	anubis        AnubisSolver
}

func NewIconService(dataDir string, feeds repository.FeedRepository, clientFactory *network.ClientFactory, anubisSolver AnubisSolver) IconService {
	return &iconService{
		dataDir:       dataDir,
		feeds:         feeds,
		clientFactory: clientFactory,
		anubis:        anubisSolver,
	}
}

// supportedIconExts lists all supported icon extensions
var supportedIconExts = []string{".png", ".ico", ".svg", ".jpg", ".jpeg", ".gif"}

// findExistingIcon checks if an icon already exists for the given base name (without extension)
// Returns the full filename if found, empty string otherwise
func (s *iconService) findExistingIcon(baseName string) string {
	for _, ext := range supportedIconExts {
		filename := baseName + ext
		fullPath := filepath.Join(s.dataDir, "icons", filename)
		if _, err := os.Stat(fullPath); err == nil {
			return filename
		}
	}
	return ""
}

// FetchAndSaveIcon 不带来源信息（凑不齐 feed 的老调用点）：走全局代理。
func (s *iconService) FetchAndSaveIcon(ctx context.Context, feedImageURL, siteURL string) (string, error) {
	return s.FetchAndSaveIconForFeed(ctx, 0, feedImageURL, siteURL)
}

// FetchAndSaveIconForFeed 按来源（订阅）取代理抓图标：订阅 → 文件夹父级链 → 全局。
// feedID <= 0 时退回全局那份（老行为）。
func (s *iconService) FetchAndSaveIconForFeed(ctx context.Context, feedID int64, feedImageURL, siteURL string) (string, error) {
	feedImageURL = strings.TrimSpace(feedImageURL)

	// Check if icon already exists before downloading
	// For RSS image: check hash-based filename
	// For favicon: check domain-based filename
	if feedImageURL != "" {
		hash := sha256.Sum256([]byte(feedImageURL))
		baseName := hex.EncodeToString(hash[:8])
		if existing := s.findExistingIcon(baseName); existing != "" {
			return existing, nil
		}
	} else if siteURL != "" {
		if parsed, err := url.Parse(siteURL); err == nil && parsed.Hostname() != "" {
			baseName := filepath.Clean(parsed.Hostname())
			if existing := s.findExistingIcon(baseName); existing != "" {
				return existing, nil
			}
		}
	}

	// 候选顺序（25-2 起）：
	// 1. RSS 里的 <image>
	// 2. 站点 /favicon.ico
	// 3. 站点首页 HTML 里声明的 <link rel="icon|shortcut icon|apple-touch-icon">（都是拼不出来的地址）
	// 4. Google Favicon API
	// 5. DuckDuckGo Favicon API
	var urlsToTry []string
	var isRSSImage bool

	if feedImageURL != "" {
		urlsToTry = append(urlsToTry, feedImageURL)
		isRSSImage = true
	}

	// Add local favicon.ico
	if localURL := s.buildLocalFaviconURL(siteURL); localURL != "" {
		urlsToTry = append(urlsToTry, localURL)
	}

	if len(urlsToTry) == 0 {
		return "", nil
	}

	// Try each URL until one succeeds
	result, successURL, lastErr := s.tryDownloadIconURLs(ctx, urlsToTry, feedID)

	// 25-2：站点把图标放在别处（CDN / 子路径 / 相对路径）时，唯一的出路是去读首页 HTML。
	// 放在这里而不是拼进上面的列表，是为了**只有前面都没命中**才多花这一次首页请求。
	if result == nil {
		if declared := s.declaredIconURLs(ctx, siteURL, feedID); len(declared) > 0 {
			result, successURL, lastErr = s.tryDownloadIconURLs(ctx, declared, feedID)
		}
	}

	// 最后才轮到第三方 favicon 服务：自建环境（NAS 等）常年直连不可达，只能当兜底
	if result == nil {
		var fallbacks []string
		if googleURL := s.buildFaviconURL(siteURL); googleURL != "" {
			fallbacks = append(fallbacks, googleURL)
		}
		if ddgURL := s.buildDDGFaviconURL(siteURL); ddgURL != "" {
			fallbacks = append(fallbacks, ddgURL)
		}
		result, successURL, lastErr = s.tryDownloadIconURLs(ctx, fallbacks, feedID)
	}

	if result == nil {
		logger.Debug("icon download attempts failed", "module", "service", "action", "fetch", "resource", "icon", "result", "failed", "error", lastErr)
		return "", nil // All attempts failed, icon is optional
	}

	// Determine filename based on source:
	// - RSS image: use URL hash + detected extension
	// - Favicon: use domain + detected extension
	var iconPath string
	if isRSSImage && successURL == feedImageURL {
		// RSS image: hash-based filename
		hash := sha256.Sum256([]byte(feedImageURL))
		iconPath = hex.EncodeToString(hash[:8]) + "." + result.format.ext
	} else {
		// Favicon: domain-based filename
		iconPath = iconFilename(siteURL, result.format.ext)
		if iconPath == "" {
			return "", nil
		}
	}

	fullPath := filepath.Join(s.dataDir, "icons", iconPath)

	// Check if icon already exists
	if _, err := os.Stat(fullPath); err == nil {
		return iconPath, nil
	}

	// Save to file
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return "", fmt.Errorf("create icons dir: %w", err)
	}

	if err := os.WriteFile(fullPath, result.data, 0644); err != nil {
		return "", fmt.Errorf("write icon file: %w", err)
	}

	logger.Info("icon saved", "module", "service", "action", "save", "resource", "icon", "result", "ok", "path", iconPath, "host", network.ExtractHost(siteURL), "format", result.format.ext)
	return iconPath, nil
}

// EnsureIcon 不带来源信息（凑不齐 feed 的老调用点）：走全局代理。
func (s *iconService) EnsureIcon(ctx context.Context, iconPath, siteURL string) error {
	return s.EnsureIconForFeed(ctx, 0, iconPath, siteURL)
}

// EnsureIconForFeed 按来源（订阅）取代理补下载图标：订阅 → 文件夹父级链 → 全局。
func (s *iconService) EnsureIconForFeed(ctx context.Context, feedID int64, iconPath, siteURL string) error {
	if iconPath == "" {
		return nil
	}

	// Validate path to prevent path traversal attacks
	if !isValidIconPath(iconPath) {
		return nil
	}

	// Clean to prevent path traversal
	iconPath = filepath.Clean(iconPath)
	fullPath := filepath.Join(s.dataDir, "icons", iconPath)

	// Check if file exists
	if _, err := os.Stat(fullPath); err == nil {
		return nil // File exists
	}

	// Check if this is a hash-based filename (16 hex chars + image extension)
	// Hash-based icons (e.g., user avatars) cannot be recovered without the original URL
	if isHashFilename(iconPath) {
		return nil // Cannot recover, skip
	}

	// File missing, try to re-download:
	// 1. Local /favicon.ico
	// 2. Google Favicon API
	var iconData []byte
	var err error

	// Try local favicon.ico first
	if localURL := s.buildLocalFaviconURL(siteURL); localURL != "" {
		iconData, err = s.downloadIcon(ctx, localURL, feedID)
		if err != nil {
			logger.Debug("local favicon.ico download failed", "module", "service", "action", "fetch", "resource", "icon", "result", "failed", "host", network.ExtractHost(localURL), "error", err)
		}
	}

	// Fallback to Google Favicon API
	if iconData == nil {
		googleURL := s.buildFaviconURL(siteURL)
		if googleURL == "" {
			return nil
		}
		iconData, err = s.downloadIcon(ctx, googleURL, feedID)
		if err != nil {
			return nil // Silently fail
		}
	}

	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return fmt.Errorf("create icons dir: %w", err)
	}

	if err := os.WriteFile(fullPath, iconData, 0644); err != nil {
		return fmt.Errorf("write icon file: %w", err)
	}

	return nil
}

// isHashFilename checks if the filename is a hash-based name (16 hex chars + image extension)
func isHashFilename(filename string) bool {
	var name string
	hasValidExt := false
	for _, ext := range supportedIconExts {
		if strings.HasSuffix(filename, ext) {
			name = strings.TrimSuffix(filename, ext)
			hasValidExt = true
			break
		}
	}

	if !hasValidExt {
		return false
	}

	if len(name) != 16 {
		return false
	}

	for _, c := range name {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// isValidIconPath checks if the icon path is safe (no absolute path or parent directory reference)
func isValidIconPath(iconPath string) bool {
	if iconPath == "" {
		return false
	}
	cleaned := filepath.Clean(iconPath)
	// Reject absolute paths
	if filepath.IsAbs(cleaned) {
		return false
	}
	// Reject paths that try to escape (start with .. or contain ../)
	if strings.HasPrefix(cleaned, "..") {
		return false
	}
	return true
}

func (s *iconService) EnsureIconByFeedID(ctx context.Context, feedID int64, iconPath string) error {
	if iconPath == "" {
		return fmt.Errorf("empty icon path")
	}

	// Get feed to get siteURL
	feed, err := s.feeds.GetByID(ctx, feedID)
	if err != nil {
		return fmt.Errorf("get feed: %w", err)
	}

	siteURL := ""
	if feed.SiteURL != nil {
		siteURL = *feed.SiteURL
	}

	return s.EnsureIconForFeed(ctx, feedID, iconPath, siteURL)
}

func (s *iconService) GetIconPath(filename string) string {
	// Validate path to prevent path traversal attacks
	if !isValidIconPath(filename) {
		return ""
	}
	// Clean to prevent path traversal
	return filepath.Join(s.dataDir, "icons", filepath.Clean(filename))
}

func (s *iconService) BackfillIcons(ctx context.Context) error {

	// 1. Fetch icons for feeds without icon_path in DB
	feeds, err := s.feeds.ListWithoutIcon(ctx)
	if err != nil {
		logger.Error("icon backfill list feeds failed", "module", "service", "action", "list", "resource", "icon", "result", "failed", "error", err)
		return fmt.Errorf("list feeds without icon: %w", err)
	}
	if len(feeds) > 0 {
		logger.Info("icon backfill started", "module", "service", "action", "fetch", "resource", "icon", "result", "ok", "count", len(feeds))
	}
	s.fetchIconsForFeeds(ctx, feeds)

	// 2. Re-download missing or stale icon files
	allFeeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		logger.Error("icon backfill list all feeds failed", "module", "service", "action", "list", "resource", "icon", "result", "failed", "error", err)
		return fmt.Errorf("list all feeds: %w", err)
	}

	const iconMaxAge = 30 * 24 * time.Hour // 30 days
	now := time.Now()

	var feedsNeedRefetch []int64
	for _, feed := range allFeeds {
		if feed.IconPath == nil || *feed.IconPath == "" {
			continue
		}

		// Validate path to prevent path traversal attacks
		if !isValidIconPath(*feed.IconPath) {
			continue
		}

		// Clean to prevent path traversal
		cleanPath := filepath.Clean(*feed.IconPath)
		fullPath := filepath.Join(s.dataDir, "icons", cleanPath)
		info, statErr := os.Stat(fullPath)
		needRefresh := statErr != nil || now.Sub(info.ModTime()) > iconMaxAge
		if !needRefresh {
			continue
		}

		// Hash-based icons need re-fetch via RSS parsing
		if isHashFilename(*feed.IconPath) {
			feedsNeedRefetch = append(feedsNeedRefetch, feed.ID)
			continue
		}

		// Domain-based icons can be re-downloaded directly
		siteURL := feed.URL
		if feed.SiteURL != nil && *feed.SiteURL != "" {
			siteURL = *feed.SiteURL
		}
		_ = s.EnsureIconForFeed(ctx, feed.ID, *feed.IconPath, siteURL)
	}

	// 3. Re-fetch hash-based icons by clearing DB and re-parsing RSS
	if len(feedsNeedRefetch) > 0 {
		for _, feedID := range feedsNeedRefetch {
			_ = s.feeds.UpdateIconPath(ctx, feedID, "")
		}
		if feedsToRefetch, err := s.feeds.ListWithoutIcon(ctx); err == nil {
			s.fetchIconsForFeeds(ctx, feedsToRefetch)
		} else {
			logger.Warn("icon backfill refetch list failed", "module", "service", "action", "list", "resource", "icon", "result", "failed", "error", err)
		}
	}

	logger.Info("icon backfill completed", "module", "service", "action", "fetch", "resource", "icon", "result", "ok")
	return nil
}

// fetchIconsForFeeds parses RSS feeds to get imageURL and fetches icons concurrently
// （parser 在每条订阅的 goroutine 里各建一个：要把「按来源生效的代理」装进去，共享实例会被并发改 Client）
func (s *iconService) fetchIconsForFeeds(ctx context.Context, feeds []model.Feed) {
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(maxConcurrentIcons)

	for _, feed := range feeds {
		feed := feed // capture loop variable
		g.Go(func() error {
			siteURL := feed.URL
			if feed.SiteURL != nil && *feed.SiteURL != "" {
				siteURL = *feed.SiteURL
			}

			// Try to parse feed to get imageURL from RSS
			// 这一步也是出网请求：按这条订阅生效的代理走（自己建一个 parser，避免共享实例被并发改 Client）
			imageURL := ""
			feedParser := gofeed.NewParser()
			feedParser.Client = s.clientFactory.NewHTTPClientForFeed(ctx, feed.ID, iconTimeout)
			if parsed, err := feedParser.ParseURLWithContext(feed.URL, ctx); err == nil && parsed.Image != nil {
				imageURL = strings.TrimSpace(parsed.Image.URL)
			}

			iconPath, err := s.FetchAndSaveIconForFeed(ctx, feed.ID, imageURL, siteURL)
			if err != nil || iconPath == "" {
				if err != nil {
					logger.Debug("icon fetch failed", "module", "service", "action", "fetch", "resource", "icon", "result", "failed", "feed_id", feed.ID, "error", err)
				}
				return nil // Don't propagate error, continue with other feeds
			}
			_ = s.feeds.UpdateIconPath(ctx, feed.ID, iconPath)
			return nil

		})
	}

	_ = g.Wait()
}

func (s *iconService) buildFaviconURL(siteURL string) string {
	if siteURL == "" {
		return ""
	}

	parsed, err := url.Parse(siteURL)
	if err != nil {
		return ""
	}

	domain := parsed.Hostname()
	if domain == "" {
		return ""
	}

	return fmt.Sprintf("https://www.google.com/s2/favicons?domain=%s&sz=128", url.QueryEscape(domain))
}

// buildLocalFaviconURL constructs the URL for the site's /favicon.ico
func (s *iconService) buildLocalFaviconURL(siteURL string) string {
	if siteURL == "" {
		return ""
	}

	parsed, err := url.Parse(siteURL)
	if err != nil {
		return ""
	}

	if parsed.Hostname() == "" {
		return ""
	}

	// Construct https://{host}/favicon.ico
	scheme := parsed.Scheme
	if scheme == "" {
		scheme = "https"
	}

	return fmt.Sprintf("%s://%s/favicon.ico", scheme, parsed.Host)
}

// buildDDGFaviconURL constructs the DuckDuckGo favicon API URL
func (s *iconService) buildDDGFaviconURL(siteURL string) string {
	if siteURL == "" {
		return ""
	}

	parsed, err := url.Parse(siteURL)
	if err != nil {
		return ""
	}

	domain := parsed.Hostname()
	if domain == "" {
		return ""
	}

	return fmt.Sprintf("https://icons.duckduckgo.com/ip3/%s.ico", domain)
}

// tryDownloadIconURLs 按顺序试一组图标地址：第一个成功的连地址一起返回，全失败则返回最后一次的错。
func (s *iconService) tryDownloadIconURLs(ctx context.Context, urls []string, feedID int64) (*iconDownloadResult, string, error) {
	var lastErr error
	for _, iconURL := range urls {
		result, err := s.downloadIconWithFormat(ctx, iconURL, feedID)
		if err == nil {
			return result, iconURL, nil
		}
		lastErr = err
		logger.Debug("icon download failed", "module", "service", "action", "fetch", "resource", "icon", "result", "failed", "host", network.ExtractHost(iconURL), "error", lastErr)
	}
	return nil, "", lastErr
}

// declaredIconURLs 抓站点首页 HTML，取出 <link rel="…icon…"> 里声明的图标地址（绝对化后按文档顺序）。
//
// 25-2：只试「站点/favicon.ico」时，凡是把图标放在别处的站点就永远抓不到 ——
// sspai 放 cdn-static、appinn 放 CDN、ncase.me 用相对路径 favicon.png，
// 实测这些地址在自建环境（NAS 直连）也是 200，纯粹是没人去读 HTML。
func (s *iconService) declaredIconURLs(ctx context.Context, siteURL string, feedID int64) []string {
	if strings.TrimSpace(siteURL) == "" {
		return nil
	}

	base, err := url.Parse(siteURL)
	if err != nil || base.Hostname() == "" {
		return nil
	}

	page, err := s.fetchPageHTML(ctx, base.String(), feedID)
	if err != nil {
		logger.Debug("icon page fetch failed", "module", "service", "action", "fetch", "resource", "icon", "result", "failed", "host", network.ExtractHost(siteURL), "error", err)
		return nil
	}

	return extractIconURLs(base, page)
}

// fetchPageHTML 取站点首页（只读前 htmlIconScanBytes 字节）。
//
// 这是 25-2 新增的兜底路径，刻意做得比图标下载更"轻"：短超时、不参与 Anubis 挑战重试 ——
// 失败就直接交给后面的 Google / DuckDuckGo，不值得为它把整轮回填拖住。
func (s *iconService) fetchPageHTML(ctx context.Context, pageURL string, feedID int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", config.DefaultUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	client := s.clientFactory.NewHTTPClientForFeed(ctx, feedID, htmlIconTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	return io.ReadAll(io.LimitReader(resp.Body, htmlIconScanBytes))
}

// extractIconURLs 从 HTML 里按文档顺序收集图标地址，并解析成绝对 URL（去重）。
// 跳过 mask-icon（单色 svg，多用于"固定到桌面"，拿来当订阅图标是一块死灰）与 data: 内联图标（没有可下载的地址）。
func extractIconURLs(base *url.URL, page []byte) []string {
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil {
		return nil
	}

	var urls []string
	seen := make(map[string]bool)
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "link" && isIconRel(linkAttr(n, "rel")) {
			if resolved := resolveIconHref(base, linkAttr(n, "href")); resolved != "" && !seen[resolved] {
				seen[resolved] = true
				urls = append(urls, resolved)
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)

	return urls
}

func linkAttr(n *html.Node, key string) string {
	for _, attr := range n.Attr {
		if strings.EqualFold(attr.Key, key) {
			return strings.TrimSpace(attr.Val)
		}
	}
	return ""
}

// isIconRel 判 rel 是否声明了图标：`icon` / `shortcut icon` / `apple-touch-icon[-precomposed]` 都算，`mask-icon` 不算。
func isIconRel(rel string) bool {
	for _, field := range strings.Fields(strings.ToLower(rel)) {
		if strings.Contains(field, "icon") && !strings.Contains(field, "mask") {
			return true
		}
	}
	return false
}

// resolveIconHref 把 href 解析成绝对地址：相对路径按首页地址解析（ncase.me 写的就是 `favicon.png`）。
func resolveIconHref(base *url.URL, href string) string {
	if href == "" || strings.HasPrefix(strings.ToLower(href), "data:") {
		return ""
	}

	ref, err := url.Parse(href)
	if err != nil {
		return ""
	}

	abs := base.ResolveReference(ref)
	if (abs.Scheme != "http" && abs.Scheme != "https") || abs.Hostname() == "" {
		return ""
	}

	return abs.String()
}

// iconFilename generates a filename based on the domain and extension
// ext should include the dot, e.g., ".png", ".ico", ".svg"
func iconFilename(siteURL, ext string) string {
	if siteURL == "" {
		return ""
	}

	parsed, err := url.Parse(siteURL)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}

	// Default to .png if no extension provided
	if ext == "" {
		ext = ".png"
	}

	// Ensure extension starts with dot
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}

	// Clean to prevent path traversal
	return filepath.Clean(parsed.Hostname()) + ext
}

// iconDownloadResult holds the downloaded icon data and format info
type iconDownloadResult struct {
	data   []byte
	format *iconFormat
}

func (s *iconService) downloadIcon(ctx context.Context, iconURL string, feedID int64) ([]byte, error) {
	result, err := s.downloadIconWithFormat(ctx, iconURL, feedID)
	if err != nil {
		return nil, err
	}
	return result.data, nil
}

// downloadIconWithFormat downloads icon and detects its format
func (s *iconService) downloadIconWithFormat(ctx context.Context, iconURL string, feedID int64) (*iconDownloadResult, error) {
	return s.downloadIconWithRetry(ctx, iconURL, "", 0, feedID)
}

func (s *iconService) downloadIconWithRetry(ctx context.Context, iconURL string, cookie string, retryCount int, feedID int64) (*iconDownloadResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, iconURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", config.DefaultUserAgent)

	// Add cookie (either provided or from cache)
	if cookie == "" {
		if parsed, err := url.Parse(iconURL); err == nil {
			if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, parsed.Host, req.Header); cachedCookie != "" {
				cookie = cachedCookie
			}
		}
	}

	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	httpClient := s.clientFactory.NewHTTPClientForFeed(ctx, feedID, iconTimeout)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, data, iconURL, resp.Cookies(), req.Header.Clone(), retryCount)
	switch {
	case anubisErr == nil:
		logger.Debug("icon download detected anubis challenge", "module", "service", "action", "fetch", "resource", "icon", "result", "ok", "host", network.ExtractHost(iconURL))
		// Retry with fresh client to avoid connection reuse
		return s.downloadIconWithFreshClient(ctx, iconURL, newCookie, retryCount+1, feedID)
	case errors.Is(anubisErr, errAnubisNotPage):
		// Not an Anubis page; continue normal icon decoding.
	case errors.Is(anubisErr, errAnubisRejected):
		return nil, fmt.Errorf("upstream rejected")
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		return nil, fmt.Errorf("anubis challenge persists after %d retries", retryCount)
	default:
		return nil, anubisErr
	}

	// Detect format and validate dimensions (besticon approach)
	format, err := detectImageFormat(data)
	if err != nil {
		return nil, fmt.Errorf("invalid icon format: %w", err)
	}

	return &iconDownloadResult{
		data:   data,
		format: format,
	}, nil
}

// downloadIconWithFreshClient creates a new http.Client to avoid connection reuse after Anubis
func (s *iconService) downloadIconWithFreshClient(ctx context.Context, iconURL string, cookie string, retryCount int, feedID int64) (*iconDownloadResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, iconURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", config.DefaultUserAgent)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	// Use fresh client to avoid connection reuse（仍按这条订阅生效的代理）
	freshClient := s.clientFactory.NewHTTPClientForFeed(ctx, feedID, iconTimeout)
	resp, err := freshClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, data, iconURL, resp.Cookies(), req.Header.Clone(), retryCount)
	switch {
	case anubisErr == nil:
		return s.downloadIconWithFreshClient(ctx, iconURL, newCookie, retryCount+1, feedID)
	case errors.Is(anubisErr, errAnubisNotPage):
		// Not an Anubis page; continue normal icon decoding.
	case errors.Is(anubisErr, errAnubisRejected):
		return nil, fmt.Errorf("upstream rejected")
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		return nil, fmt.Errorf("anubis challenge persists after %d retries", retryCount)
	default:
		return nil, anubisErr
	}

	// Detect format and validate dimensions (besticon approach)
	format, err := detectImageFormat(data)
	if err != nil {
		return nil, fmt.Errorf("invalid icon format: %w", err)
	}

	return &iconDownloadResult{
		data:   data,
		format: format,
	}, nil
}

func (s *iconService) ClearAllIcons(ctx context.Context) (int64, error) {
	// 1. Delete all icon files from the icons directory
	iconsDir := filepath.Join(s.dataDir, "icons")
	entries, err := os.ReadDir(iconsDir)
	if err != nil && !os.IsNotExist(err) {
		logger.Error("icon cache read failed", "module", "service", "action", "clear", "resource", "icon", "result", "failed", "error", err)
		return 0, fmt.Errorf("read icons dir: %w", err)
	}

	var deletedFiles int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		filePath := filepath.Join(iconsDir, entry.Name())
		if err := os.Remove(filePath); err == nil {
			deletedFiles++
		}
	}

	// 2. Clear all icon_path in database
	_, err = s.feeds.ClearAllIconPaths(ctx)
	if err != nil {
		logger.Error("icon cache clear db failed", "module", "service", "action", "clear", "resource", "icon", "result", "failed", "error", err)
		return deletedFiles, fmt.Errorf("clear icon paths in db: %w", err)
	}

	// 3. Clear ETag and Last-Modified to force full refresh on next update
	// This ensures icons will be re-fetched even if feed returns 304 Not Modified
	_, err = s.feeds.ClearAllConditionalGet(ctx)
	if err != nil {
		logger.Error("icon cache clear conditional get failed", "module", "service", "action", "clear", "resource", "icon", "result", "failed", "error", err)
		return deletedFiles, fmt.Errorf("clear conditional get: %w", err)
	}

	logger.Info("icon cache cleared", "module", "service", "action", "clear", "resource", "icon", "result", "ok", "count", deletedFiles)
	return deletedFiles, nil
}

// isSVG detects if the data is an SVG image (similar to besticon's approach)
func isSVG(data []byte) bool {
	// Check minimum length
	if len(data) < 10 {
		return false
	}

	// Check if it starts with something reasonable
	switch {
	case bytes.HasPrefix(data, []byte("<!")):
	case bytes.HasPrefix(data, []byte("<?")):
	case bytes.HasPrefix(data, []byte("<svg")):
	default:
		return false
	}

	// Check if there's an <svg tag in the first 300 bytes
	searchLen := len(data)
	if searchLen > 300 {
		searchLen = 300
	}
	if off := bytes.Index(data[:searchLen], []byte("<svg")); off == -1 {
		return false
	}

	return true
}

// isICO detects if the data is an ICO image
// ICO format: first 4 bytes are 0x00 0x00 0x01 0x00 (or 0x02 0x00 for CUR)
func isICO(data []byte) bool {
	if len(data) < 6 {
		return false
	}
	// Check ICO magic number: 0x00 0x00 0x01 0x00
	// CUR files use 0x00 0x00 0x02 0x00, we accept both
	if data[0] == 0x00 && data[1] == 0x00 && (data[2] == 0x01 || data[2] == 0x02) && data[3] == 0x00 {
		// Additional check: bytes 4-5 contain the number of images (should be > 0)
		numImages := int(data[4]) | int(data[5])<<8
		return numImages > 0
	}
	return false
}

// iconFormat holds detected format information
type iconFormat struct {
	ext    string // e.g., "png", "ico", "svg", "jpg", "gif"
	width  int
	height int
}

// detectImageFormat detects the format and dimensions of image data
// Returns format info or error if format is unrecognized or dimensions are invalid
func detectImageFormat(data []byte) (*iconFormat, error) {
	// Special handling for SVG (golang can't decode with image.DecodeConfig)
	if isSVG(data) {
		return &iconFormat{
			ext:    "svg",
			width:  9999, // SVG is vector, use large value like besticon
			height: 9999,
		}, nil
	}

	// Special handling for ICO (golang standard library doesn't support ICO)
	if isICO(data) {
		return &iconFormat{
			ext:    "ico",
			width:  32, // Default size, actual size varies
			height: 32,
		}, nil
	}

	// Try to decode as raster image
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("unknown image format: %w", err)
	}

	// Normalize format name (jpeg -> jpg)
	if format == "jpeg" {
		format = "jpg"
	}

	// Filter out invalid dimensions (like 1x1 tracking pixels)
	if cfg.Width <= 1 || cfg.Height <= 1 {
		return nil, fmt.Errorf("icon dimensions too small: %dx%d", cfg.Width, cfg.Height)
	}

	return &iconFormat{
		ext:    format,
		width:  cfg.Width,
		height: cfg.Height,
	}, nil
}
