package service_test

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	mock_repo "krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	"krss/backend/pkg/opml"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

const sampleOPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Tech">
      <outline text="Feed A" xmlUrl="https://a.com/rss" />
    </outline>
    <outline text="Feed B" xmlUrl="https://b.com/rss" />
  </body>
</opml>`

func TestOPMLService_Import_Invalid(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := service.NewOPMLService(nil, nil, nil, nil, mock_repo.NewMockFolderRepository(ctrl), mock_repo.NewMockFeedRepository(ctrl))
	_, err := svc.Import(context.Background(), strings.NewReader("<invalid"), nil)
	require.ErrorIs(t, err, service.ErrInvalid)
}

func TestOPMLService_Import_CreatesFoldersAndFeeds(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderRepo := mock_repo.NewMockFolderRepository(ctrl)
	folderService := &folderServiceStub{nextID: 10}
	feedService := &feedServiceStub{nextID: 100}
	refreshSvc := &refreshServiceStub{done: make(chan []int64, 1)}
	iconSvc := &iconServiceStub{done: make(chan struct{}, 1)}

	folderRepo.EXPECT().FindByName(gomock.Any(), "Tech", (*int64)(nil)).Return(nil, nil)

	progressEvents := make([]service.ImportProgress, 0, 3)
	onProgress := func(p service.ImportProgress) {
		progressEvents = append(progressEvents, p)
	}

	svc := service.NewOPMLService(folderService, feedService, refreshSvc, iconSvc, folderRepo, nil)
	result, err := svc.Import(context.Background(), strings.NewReader(sampleOPML), onProgress)
	require.NoError(t, err)
	require.Equal(t, 1, result.FoldersCreated)
	require.Equal(t, 2, result.FeedsCreated)
	require.GreaterOrEqual(t, len(progressEvents), 3)
	require.Equal(t, "started", progressEvents[0].Status)
	require.Equal(t, 2, progressEvents[0].Total)

	require.Len(t, feedService.calls, 2)
	require.Equal(t, "https://a.com/rss", feedService.calls[0].url)
	require.Equal(t, "https://b.com/rss", feedService.calls[1].url)
	require.NotNil(t, feedService.calls[0].folderID)
	require.Equal(t, int64(10), *feedService.calls[0].folderID)
	require.Nil(t, feedService.calls[1].folderID)

	select {
	case ids := <-refreshSvc.done:
		require.Len(t, ids, 2)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected refresh to run")
	}

	select {
	case <-iconSvc.done:
	case <-time.After(500 * time.Millisecond):
		// 图标回填在后台 goroutine 里跑，用 default 分支会偶发误报（既有 flake）
		t.Fatal("expected icon backfill to run")
	}
}

func TestOPMLService_Import_EmptyFolderNameUsesUntitled(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderRepo := mock_repo.NewMockFolderRepository(ctrl)
	folderService := &folderServiceStub{nextID: 1}
	feedService := &feedServiceStub{nextID: 1}

	folderRepo.EXPECT().FindByName(gomock.Any(), "Untitled", (*int64)(nil)).Return(nil, nil)

	input := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline>
      <outline text="Feed" xmlUrl="https://a.com/rss" />
    </outline>
  </body>
</opml>`

	svc := service.NewOPMLService(folderService, feedService, nil, nil, folderRepo, nil)
	_, err := svc.Import(context.Background(), strings.NewReader(input), nil)
	require.NoError(t, err)
	require.NotEmpty(t, folderService.created)
	require.Equal(t, "Untitled", folderService.created[0].Name)
}

func TestOPMLService_Export_SortsAndBuildsOutlines(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderRepo := mock_repo.NewMockFolderRepository(ctrl)
	feedRepo := mock_repo.NewMockFeedRepository(ctrl)

	folders := []model.Folder{
		{ID: 1, Name: "B Folder", Type: "picture"},
		{ID: 2, Name: "a folder", Type: "article"},
	}
	feeds := []model.Feed{
		{ID: 10, Title: "Z Feed", URL: "https://z.com/rss", Type: "social", SourceType: model.FeedSourceRSS},
		{ID: 11, Title: "A Feed", URL: "https://a.com/rss", Type: "article", SourceType: model.FeedSourceRSS},
		{ID: 12, Title: "Child", URL: "https://c.com/rss", FolderID: int64Ptr(1), SiteURL: strPtr("https://c.com"), Type: "picture", SourceType: model.FeedSourceRSS},
	}

	folderRepo.EXPECT().List(gomock.Any()).Return(folders, nil)
	feedRepo.EXPECT().List(gomock.Any(), (*int64)(nil)).Return(feeds, nil)

	svc := service.NewOPMLService(nil, nil, nil, nil, folderRepo, feedRepo)
	data, err := svc.Export(context.Background())
	require.NoError(t, err)

	doc, err := opml.Parse(bytes.NewReader(data))
	require.NoError(t, err)

	require.Len(t, doc.Body.Outlines, 4)
	require.Equal(t, "a folder", doc.Body.Outlines[0].Text)
	require.Equal(t, "B Folder", doc.Body.Outlines[1].Text)
	require.Equal(t, "A Feed", doc.Body.Outlines[2].Text)
	require.Equal(t, "Z Feed", doc.Body.Outlines[3].Text)

	child := doc.Body.Outlines[1].Outlines
	require.Len(t, child, 1)
	require.Equal(t, "https://c.com/rss", child[0].XMLURL)
	require.Equal(t, "https://c.com", child[0].HTMLURL)

	// 类型属性：文件夹与订阅的真实类型都要写进 krssType，来源写进 krssSourceType。
	require.Equal(t, "picture", doc.Body.Outlines[1].KrssType) // B Folder
	require.Equal(t, "article", doc.Body.Outlines[0].KrssType) // a folder
	require.Equal(t, "picture", child[0].KrssType)
	require.Equal(t, "rss", child[0].KrssSourceType)
	require.Equal(t, "social", doc.Body.Outlines[3].KrssType) // Z Feed
}

func TestOPMLService_Import_RestoresTypedFeedsAndFolders(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	const typedOPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Pics" krssType="picture">
      <outline text="Pic Feed" xmlUrl="https://p.com/rss" krssType="picture" krssSourceType="rss" />
    </outline>
    <outline text="Social Feed" xmlUrl="https://s.com/rss" krssType="social" krssSourceType="rss" />
  </body>
</opml>`

	folderRepo := mock_repo.NewMockFolderRepository(ctrl)
	folderService := &folderServiceStub{nextID: 10}
	feedService := &feedServiceStub{nextID: 100}

	folderRepo.EXPECT().FindByName(gomock.Any(), "Pics", (*int64)(nil)).Return(nil, nil)

	svc := service.NewOPMLService(folderService, feedService, nil, nil, folderRepo, nil)
	result, err := svc.Import(context.Background(), strings.NewReader(typedOPML), nil)
	require.NoError(t, err)
	require.Equal(t, 1, result.FoldersCreated)
	require.Equal(t, 2, result.FeedsCreated)

	// 文件夹类型按 krssType 还原（不再写死 article）。
	require.Len(t, folderService.created, 1)
	require.Equal(t, "picture", folderService.created[0].Type)

	// 嵌套订阅与文件夹同类型，AddWithoutFetch 直接按 picture 建；
	// 根级订阅默认为 article，随后 UpdateType 纠正成 social。
	require.Len(t, feedService.calls, 2)
	require.Equal(t, "picture", feedService.calls[0].feedType)
	require.Equal(t, "article", feedService.calls[1].feedType)
	require.Len(t, feedService.updateTypeCalls, 1)
	require.Equal(t, int64(101), feedService.updateTypeCalls[0].id)
	require.Equal(t, "social", feedService.updateTypeCalls[0].feedType)
}

func TestOPMLService_Import_RecreatesMCPFeed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	const mcpOPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="MCP Feed" xmlUrl="mcp://server/x" type="rss" krssType="article" krssSourceType="mcp" krssMCPConfig='{"url":"mcp://server/x"}' />
  </body>
</opml>`

	folderRepo := mock_repo.NewMockFolderRepository(ctrl)
	feedRepo := mock_repo.NewMockFeedRepository(ctrl)
	feedService := &feedServiceStub{nextID: 1}

	feedRepo.EXPECT().FindByURL(gomock.Any(), "mcp://server/x").Return(nil, nil)
	feedRepo.EXPECT().Create(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, f model.Feed) (model.Feed, error) {
			require.Equal(t, model.FeedSourceMCP, f.SourceType)
			require.Equal(t, "mcp://server/x", f.URL)
			require.NotNil(t, f.MCPConfig)
			require.Equal(t, `{"url":"mcp://server/x"}`, *f.MCPConfig)
			f.ID = 500
			return f, nil
		})

	svc := service.NewOPMLService(nil, feedService, nil, nil, folderRepo, feedRepo)
	result, err := svc.Import(context.Background(), strings.NewReader(mcpOPML), nil)
	require.NoError(t, err)
	require.Equal(t, 1, result.FeedsCreated)
	// MCP 订阅不走 AddWithoutFetch（URL 非 http(s)）。
	require.Empty(t, feedService.calls)
}

type folderServiceStub struct {
	nextID  int64
	created []model.Folder
}

func (s *folderServiceStub) Create(ctx context.Context, name string, parentID *int64, folderType string) (model.Folder, error) {
	folder := model.Folder{ID: s.nextID, Name: name, ParentID: parentID, Type: folderType}
	s.nextID++
	s.created = append(s.created, folder)
	return folder, nil
}

func (s *folderServiceStub) List(ctx context.Context) ([]model.Folder, error) {
	return nil, nil
}

func (s *folderServiceStub) Update(ctx context.Context, id int64, name string, parentID *int64, sortOrder *int64) (model.Folder, error) {
	return model.Folder{}, nil
}

func (s *folderServiceStub) UpdateType(ctx context.Context, id int64, folderType string) error {
	return nil
}

// UpdateProxyOverride 14 批新增的接口方法：stub 里不需要真的写库。
func (s *folderServiceStub) UpdateProxyOverride(ctx context.Context, id int64, update service.ProxyOverrideUpdate) (model.Folder, error) {
	return model.Folder{ID: id}, nil
}

func (s *folderServiceStub) Delete(ctx context.Context, id int64) error {
	return nil
}

type feedServiceStub struct {
	nextID          int64
	calls           []feedAddCall
	updateTypeCalls []updateTypeCall
}

type feedAddCall struct {
	url      string
	folderID *int64
	feedType string
}

type updateTypeCall struct {
	id       int64
	feedType string
}

func (s *feedServiceStub) Add(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) AddMCP(ctx context.Context, input service.MCPFeedAddInput) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) UpdateMCPConfig(ctx context.Context, id int64, input service.MCPFeedAddInput) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) AddWithoutFetch(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, bool, error) {
	s.calls = append(s.calls, feedAddCall{url: feedURL, folderID: folderID, feedType: feedType})
	feed := model.Feed{ID: s.nextID, URL: feedURL, FolderID: folderID, Title: titleOverride, Type: feedType}
	s.nextID++
	return feed, true, nil
}

func (s *feedServiceStub) Preview(ctx context.Context, feedURL string) (service.FeedPreview, error) {
	return service.FeedPreview{}, nil
}

func (s *feedServiceStub) List(ctx context.Context, folderID *int64) ([]model.Feed, error) {
	return nil, nil
}

func (s *feedServiceStub) Update(ctx context.Context, id int64, title string, folderID *int64, summaryPromptReminder *string, sortOrder *int64) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) MoveToFolder(ctx context.Context, id int64, folderID *int64) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) UpdateType(ctx context.Context, id int64, feedType string) error {
	s.updateTypeCalls = append(s.updateTypeCalls, updateTypeCall{id: id, feedType: feedType})
	return nil
}

func (s *feedServiceStub) UpdateURL(ctx context.Context, id int64, feedURL string) (model.Feed, error) {
	return model.Feed{}, nil
}

func (s *feedServiceStub) MergePreview(ctx context.Context, sourceID int64, targetURL string) (service.FeedMergePreview, error) {
	return service.FeedMergePreview{}, nil
}

func (s *feedServiceStub) MergeInto(ctx context.Context, sourceID, targetID int64) (service.FeedMergeResult, error) {
	return service.FeedMergeResult{}, nil
}

func (s *feedServiceStub) Delete(ctx context.Context, id int64) error {
	return nil
}

func (s *feedServiceStub) DeleteBatch(ctx context.Context, ids []int64) error {
	return nil
}

type refreshServiceStub struct {
	done chan []int64
}

// LastRefreshResults 手写 stub 要跟上接口（刷新结果弹框用，用户 11-8）
func (s *refreshServiceStub) LastRefreshResults() []service.RefreshFeedResult {
	return nil
}

// ForceRefreshAll / ForceRefreshFeeds 强制拉取（11-19）：OPML 导入路径用不到，按普通刷新处理即可。
func (s *refreshServiceStub) ForceRefreshAll(ctx context.Context) error {
	return s.RefreshAll(ctx)
}

func (s *refreshServiceStub) RefreshAllAuto(ctx context.Context) error {
	return s.RefreshAll(ctx)
}

func (s *refreshServiceStub) ForceRefreshFeeds(ctx context.Context, feedIDs []int64) error {
	return s.RefreshFeeds(ctx, feedIDs)
}

func (s *refreshServiceStub) RefreshAll(ctx context.Context) error {
	return nil
}

func (s *refreshServiceStub) RefreshFeed(ctx context.Context, feedID int64) error {
	return nil
}

func (s *refreshServiceStub) RefreshFeeds(ctx context.Context, feedIDs []int64) error {
	select {
	case s.done <- append([]int64(nil), feedIDs...):
	default:
	}
	return nil
}

func (s *refreshServiceStub) IsRefreshing() bool {
	return false
}

func (s *refreshServiceStub) GetRefreshStatus() service.RefreshStatus {
	return service.RefreshStatus{}
}

// WithPlugins 55-17：stub 不接插件（OPML 导入路径不碰抓取失败归类），返回自己即可。
func (s *refreshServiceStub) WithPlugins(_ *plugin.Registry) service.RefreshService {
	return s
}

type iconServiceStub struct {
	done chan struct{}
}

func (s *iconServiceStub) FetchAndSaveIcon(ctx context.Context, feedImageURL, siteURL string) (string, error) {
	return "", nil
}

// FetchAndSaveIconForFeed / EnsureIconForFeed：14 批新增的接口方法（按来源取代理那条），stub 里不需要真抓。
func (s *iconServiceStub) FetchAndSaveIconForFeed(ctx context.Context, feedID int64, feedImageURL, siteURL string) (string, error) {
	return "", nil
}

func (s *iconServiceStub) EnsureIconForFeed(ctx context.Context, feedID int64, iconPath, siteURL string) error {
	return nil
}

func (s *iconServiceStub) EnsureIcon(ctx context.Context, iconPath, siteURL string) error {
	return nil
}

func (s *iconServiceStub) EnsureIconByFeedID(ctx context.Context, feedID int64, iconPath string) error {
	return nil
}

func (s *iconServiceStub) BackfillIcons(ctx context.Context) error {
	select {
	case s.done <- struct{}{}:
	default:
	}
	return nil
}

func (s *iconServiceStub) GetIconPath(filename string) string {
	return ""
}

func (s *iconServiceStub) ClearAllIcons(ctx context.Context) (int64, error) {
	return 0, nil
}

func int64Ptr(value int64) *int64 {
	return &value
}

func strPtr(value string) *string {
	return &value
}

// Ensure we satisfy the io.Reader interface import when not used in build tags.

func (s *feedServiceStub) UpdateAIOverrides(ctx context.Context, id int64, autoTranslate, autoSummary, readerMode *bool) (model.Feed, error) {
	return model.Feed{}, nil
}

// UpdateProxyOverride 14 批新增的接口方法：stub 里不需要真的写库。
func (s *feedServiceStub) UpdateProxyOverride(ctx context.Context, id int64, update service.ProxyOverrideUpdate) (model.Feed, error) {
	return model.Feed{ID: id}, nil
}
