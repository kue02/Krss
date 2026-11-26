//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

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
	// 列表接口一次最多带回 updateMaxReleases 条，每条的说明都可能很长，故留 8MiB。
	// 实测 Krss 自己 per_page=50 的响应约 96KB（19 条、body_html 合计 29KB），余量充足。
	updateMaxResponseBytes = 8 << 20
	// updateMaxReleases 一次最多取多少个 Release。GitHub 列表接口按发布时间倒序，
	// 一次请求就能拿到「当前版本之后的全部更新」，不必按页翻。
	// 上限 50：落后超过 50 个版本时只会列出最新 50 条（标题按实际条数显示，不谎报）。
	updateMaxReleases = 50
)

// UpdateAsset 一个发布附件（可下载文件）。
type UpdateAsset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// UpdateRelease 一个比当前版本新的 Release。
type UpdateRelease struct {
	Version     string        `json:"version"`
	Name        string        `json:"name"`
	URL         string        `json:"url"`
	PublishedAt string        `json:"publishedAt"`
	NotesHTML   string        `json:"notesHtml"`
	Assets      []UpdateAsset `json:"assets"`
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
	// Releases 当前版本之后的全部 Release，按版本从新到旧。
	// 顶上的 Release* 字段是最新那一版，保留给只关心「有没有更新」的调用方。
	Releases []UpdateRelease `json:"releases"`
}

// UpdateService 检查 Krss 自身是否有新版本。
type UpdateService interface {
	// Check 请求 GitHub 的 Release 列表，与当前运行版本比较，返回最新一版
	// 以及当前版本之后的全部 Release。
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

	// group 合并并发的冷缓存请求：GitHub 匿名接口每小时只有 60 次，
	// 多端同时打开「关于」页时不能让每个请求都真打一次（审查 P1 实测 10 并发 = 10 次出网）。
	group singleflight.Group
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
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
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
	if cached := s.cachedInfo(); cached != nil {
		return cached, nil
	}

	// 冷缓存：并发的调用合并成一次出网，拿到结果后所有等待者共享同一份。
	// 失败同样共享（不缓存），调用方各自拿到同一个错误。
	//
	// 共享的这次出网**不能**用第一个调用方的 ctx：那个人关掉标签页，
	// 所有排队等同一份结果的人都会跟着收到取消错误。改成脱离取消的 ctx
	// 再套自己的超时——调用方自己的 ctx 仍在外层 select 里各自生效。
	sharedCtx, cancelShared := context.WithTimeout(context.WithoutCancel(ctx), updateCheckTimeout)
	ch := s.group.DoChan("check", func() (any, error) {
		defer cancelShared()
		// 双检：排队期间可能已经有别的请求填好了缓存。
		if cached := s.cachedInfo(); cached != nil {
			return cached, nil
		}
		info, err := s.fetch(sharedCtx)
		if err != nil {
			s.logCheckFailure(err)
			return nil, err
		}
		s.mu.Lock()
		s.cached = info
		s.cachedAt = time.Now()
		s.mu.Unlock()
		return info, nil
	})

	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %w", ErrUpdateCheckFailed, ctx.Err())
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		info, ok := res.Val.(*UpdateInfo)
		if !ok || info == nil {
			return nil, fmt.Errorf("%w: unexpected empty result", ErrUpdateCheckFailed)
		}
		return cloneUpdateInfo(info), nil
	}
}

// cachedInfo 返回缓存副本；未命中返回 nil。
func (s *updateService) cachedInfo() *UpdateInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached == nil || time.Since(s.cachedAt) >= updateCacheTTL {
		return nil
	}
	return cloneUpdateInfo(s.cached)
}

// cloneUpdateInfo 深拷贝（Assets 切片不能与缓存共享底层数组，
// 否则调用方一排序/截断就把缓存改脏）。
func cloneUpdateInfo(info *UpdateInfo) *UpdateInfo {
	if info == nil {
		return nil
	}
	out := *info
	// make 而不是 append 到 nil：空切片要序列化成 []，不能是 null，
	// 前端拿到 null 会当成「没有这个字段」直接读 length 崩掉。
	out.Assets = make([]UpdateAsset, len(info.Assets))
	copy(out.Assets, info.Assets)
	out.Releases = make([]UpdateRelease, len(info.Releases))
	for i, rel := range info.Releases {
		cloned := rel
		cloned.Assets = make([]UpdateAsset, len(rel.Assets))
		copy(cloned.Assets, rel.Assets)
		out.Releases[i] = cloned
	}
	return &out
}

// logCheckFailure 记录失败：限流/仓库不存在属预期内状况，降为 warn，免得污染错误日志与告警。
func (s *updateService) logCheckFailure(err error) {
	fields := []any{"module", "service", "action", "check", "resource", "update", "result", "failed", "error", err}
	if errors.Is(err, ErrUpdateRateLimited) || errors.Is(err, ErrUpdateReleaseNotFound) {
		logger.Warn("update check failed", fields...)
		return
	}
	logger.Error("update check failed", fields...)
}

func (s *updateService) fetch(ctx context.Context) (*UpdateInfo, error) {
	// 用列表接口而不是 /releases/latest：详情页要展示「当前版本之后的全部更新」，
	// 一次拿回整张列表，顺带省掉一次出网（GitHub 匿名限流每小时只有 60 次）。
	endpoint := fmt.Sprintf("%s/repos/%s/releases?per_page=%d", s.apiBase, s.repo, updateMaxReleases)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpdateCheckFailed, err)
	}
	// html 媒体类型：GitHub 直接返回渲染好的 body_html，前端不必自己解析 Markdown。
	// 列表接口同样支持，每个 release 各带自己的 body_html。
	req.Header.Set("Accept", "application/vnd.github.html+json")
	req.Header.Set("User-Agent", config.KrssUserAgent)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := s.clientFactory.NewHTTPClient(ctx, updateCheckTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpdateCheckFailed, err)
	}
	defer resp.Body.Close()

	// 把「限流」与「仓库不存在」分出来：它们对用户是不同的排查方向，
	// 塌缩成一句「连不上 GitHub」只会让人一直重试（而每次重试都真打一次 GitHub）。
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden, http.StatusTooManyRequests:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("%w: github status %d: %s", ErrUpdateRateLimited, resp.StatusCode, strings.TrimSpace(string(body)))
	case http.StatusNotFound:
		return nil, fmt.Errorf("%w: %s", ErrUpdateReleaseNotFound, s.repo)
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("%w: github status %d: %s", ErrUpdateCheckFailed, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// 先按上限多读 1 字节再判断：GitHub 若不给 Content-Length（分块响应），
	// 直接交给 json.Decoder 只会得到「decode: unexpected EOF」，看不出是响应过大。
	if resp.ContentLength > updateMaxResponseBytes {
		return nil, fmt.Errorf("%w: response too large (%d bytes)", ErrUpdateCheckFailed, resp.ContentLength)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, updateMaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read body: %v", ErrUpdateCheckFailed, err)
	}
	if int64(len(raw)) > updateMaxResponseBytes {
		return nil, fmt.Errorf("%w: response too large (>%d bytes)", ErrUpdateCheckFailed, updateMaxResponseBytes)
	}

	var rels []githubRelease
	if err := json.Unmarshal(raw, &rels); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpdateCheckFailed, err)
	}

	// 草稿与预发布不算正式版本：草稿根本不该被外人看到，
	// 预发布版给所有人推「可更新」会把 beta 用户之外的人带到不稳定的版本上。
	published := make([]githubRelease, 0, len(rels))
	for _, rel := range rels {
		if rel.Draft || rel.Prerelease {
			continue
		}
		if strings.TrimSpace(rel.TagName) == "" {
			continue
		}
		published = append(published, rel)
	}
	if len(published) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrUpdateReleaseNotFound, s.repo)
	}

	// 列表接口按创建时间倒序，但版本号未必同序（热修版本可能后发却号更小），
	// 显式按版本号排序，保证「最新」真的是最大的那个。
	sort.SliceStable(published, func(i, j int) bool {
		return compareVersions(published[i].TagName, published[j].TagName) > 0
	})

	newer := make([]UpdateRelease, 0, len(published))
	for _, rel := range published {
		tag := strings.TrimSpace(rel.TagName)
		if compareVersions(tag, s.currentVersion) <= 0 {
			continue
		}
		name := strings.TrimSpace(rel.Name)
		if name == "" {
			name = tag
		}
		assets := make([]UpdateAsset, 0, len(rel.Assets))
		for _, a := range rel.Assets {
			assets = append(assets, UpdateAsset{
				Name: a.Name,
				URL:  a.BrowserDownloadURL,
				Size: a.Size,
			})
		}
		newer = append(newer, UpdateRelease{
			Version:     tag,
			Name:        name,
			URL:         rel.HTMLURL,
			PublishedAt: rel.PublishedAt,
			NotesHTML:   rel.BodyHTML,
			Assets:      assets,
		})
	}

	latest := published[0]
	latestTag := strings.TrimSpace(latest.TagName)
	latestName := strings.TrimSpace(latest.Name)
	if latestName == "" {
		latestName = latestTag
	}
	info := &UpdateInfo{
		CurrentVersion:   s.currentVersion,
		LatestVersion:    latestTag,
		HasUpdate:        len(newer) > 0,
		ReleaseName:      latestName,
		ReleaseURL:       latest.HTMLURL,
		PublishedAt:      latest.PublishedAt,
		ReleaseNotesHTML: latest.BodyHTML,
		Assets:           make([]UpdateAsset, 0, len(latest.Assets)),
		Releases:         newer,
	}
	for _, a := range latest.Assets {
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
