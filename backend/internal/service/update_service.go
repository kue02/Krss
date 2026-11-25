//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"krss/backend/internal/config"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

const (
	// defaultUpdateAPIBase GitHub API 根地址；测试可用 WithUpdateAPIBase 换成 httptest。
	defaultUpdateAPIBase = "https://api.github.com"
	// updateCacheTTL 检查结果缓存时长：GitHub 匿名接口每小时 60 次，
	// 前端「打开关于页自动检查 + 手动按钮」很容易打满，服务端兜一层缓存。
	updateCacheTTL = 10 * time.Minute
	// updateCheckTimeout 单次请求 GitHub 的超时。
	updateCheckTimeout = 10 * time.Second
	// updateMaxResponseBytes 发布说明 body_html 可能很长，限一个上限防止异常体量。
	updateMaxResponseBytes = 4 << 20
)

// UpdateAsset 一个发布附件（可下载文件）。
type UpdateAsset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// UpdateInfo 一次「检查更新」的结果，直接作为 /api/update/check 的响应体。
type UpdateInfo struct {
	CurrentVersion   string        `json:"currentVersion"`
	LatestVersion    string        `json:"latestVersion"`
	HasUpdate        bool          `json:"hasUpdate"`
	ReleaseName      string        `json:"releaseName"`
	ReleaseURL       string        `json:"releaseUrl"`
	PublishedAt      string        `json:"publishedAt"`
	ReleaseNotesHTML string        `json:"releaseNotesHtml"`
	Assets           []UpdateAsset `json:"assets"`
}

// UpdateService 检查 Krss 自身是否有新版本。
type UpdateService interface {
	// Check 请求 GitHub 最新 Release，并与当前运行版本比较。
	// 结果按 updateCacheTTL 缓存；失败不缓存。
	Check(ctx context.Context) (*UpdateInfo, error)
}

// UpdateServiceOption 构造选项（主要用于测试）。
type UpdateServiceOption func(*updateService)

// WithUpdateAPIBase 覆盖 GitHub API 根地址（测试指向 httptest）。
func WithUpdateAPIBase(base string) UpdateServiceOption {
	return func(s *updateService) {
		s.apiBase = strings.TrimRight(base, "/")
	}
}

// WithUpdateCurrentVersion 覆盖「当前版本」（测试模拟旧/新版本）。
func WithUpdateCurrentVersion(v string) UpdateServiceOption {
	return func(s *updateService) {
		s.currentVersion = v
	}
}

type updateService struct {
	clientFactory  *network.ClientFactory
	apiBase        string
	repo           string
	currentVersion string

	mu       sync.Mutex
	cached   *UpdateInfo
	cachedAt time.Time
}

// NewUpdateService 创建更新检查服务。repo 从 config.AppRepo 派生，版本取 config.AppVersion。
func NewUpdateService(clientFactory *network.ClientFactory, opts ...UpdateServiceOption) UpdateService {
	s := &updateService{
		clientFactory:  clientFactory,
		apiBase:        defaultUpdateAPIBase,
		repo:           repoPathFromConfig(),
		currentVersion: config.AppVersion,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// repoPathFromConfig 从 "https://github.com/owner/name" 取出 "owner/name"。
func repoPathFromConfig() string {
	repo := strings.TrimSuffix(strings.TrimSpace(config.AppRepo), "/")
	repo = strings.TrimPrefix(repo, "https://github.com/")
	repo = strings.TrimPrefix(repo, "http://github.com/")
	return repo
}

// githubRelease 只取用得到的字段。
type githubRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	BodyHTML    string `json:"body_html"`
	Assets      []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

func (s *updateService) Check(ctx context.Context) (*UpdateInfo, error) {
	s.mu.Lock()
	if s.cached != nil && time.Since(s.cachedAt) < updateCacheTTL {
		cached := *s.cached
		s.mu.Unlock()
		return &cached, nil
	}
	s.mu.Unlock()

	info, err := s.fetch(ctx)
	if err != nil {
		logger.Error("update check failed", "module", "service", "action", "check", "resource", "update", "result", "failed", "error", err)
		return nil, err
	}

	s.mu.Lock()
	s.cached = info
	s.cachedAt = time.Now()
	s.mu.Unlock()

	cached := *info
	return &cached, nil
}

func (s *updateService) fetch(ctx context.Context) (*UpdateInfo, error) {
	endpoint := fmt.Sprintf("%s/repos/%s/releases/latest", s.apiBase, s.repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpdateCheckFailed, err)
	}
	// html 媒体类型：GitHub 直接返回渲染好的 body_html，前端不必自己解析 Markdown。
	req.Header.Set("Accept", "application/vnd.github.html+json")
	req.Header.Set("User-Agent", config.KrssUserAgent)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := s.clientFactory.NewHTTPClient(ctx, updateCheckTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpdateCheckFailed, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("%w: github status %d: %s", ErrUpdateCheckFailed, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var rel githubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, updateMaxResponseBytes)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpdateCheckFailed, err)
	}

	latest := strings.TrimSpace(rel.TagName)
	if latest == "" {
		return nil, fmt.Errorf("%w: empty tag_name", ErrUpdateCheckFailed)
	}

	name := strings.TrimSpace(rel.Name)
	if name == "" {
		name = latest
	}

	info := &UpdateInfo{
		CurrentVersion:   s.currentVersion,
		LatestVersion:    latest,
		HasUpdate:        compareVersions(latest, s.currentVersion) > 0,
		ReleaseName:      name,
		ReleaseURL:       rel.HTMLURL,
		PublishedAt:      rel.PublishedAt,
		ReleaseNotesHTML: rel.BodyHTML,
		Assets:           make([]UpdateAsset, 0, len(rel.Assets)),
	}
	for _, a := range rel.Assets {
		info.Assets = append(info.Assets, UpdateAsset{
			Name: a.Name,
			URL:  a.BrowserDownloadURL,
			Size: a.Size,
		})
	}
	return info, nil
}

// compareVersions 按「点分段、逐段数字比较」比较两个版本号。
// 支持 v 前缀、四段版本（如 1.1.9.1）、以及 -beta/+build 之类的后缀（截断忽略）。
// 返回 1 表示 a 比 b 新，-1 表示更旧，0 表示相同。
func compareVersions(a, b string) int {
	as := parseVersionSegments(a)
	bs := parseVersionSegments(b)
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

func parseVersionSegments(v string) []int {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	// 丢弃预发布/构建元数据
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		digits := ""
		for _, r := range p {
			if r >= '0' && r <= '9' {
				digits += string(r)
			} else {
				break
			}
		}
		if digits == "" {
			out = append(out, 0)
			continue
		}
		num, err := strconv.Atoi(digits)
		if err != nil {
			num = 0
		}
		out = append(out, num)
	}
	return out
}
