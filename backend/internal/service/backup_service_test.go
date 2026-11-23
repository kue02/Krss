package service_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"

	"github.com/stretchr/testify/require"
)

func boolPtr(v bool) *bool { return &v }

// TestBackupService_RoundTrip 用一个含多层文件夹 + 多类型订阅（含 MCP）+ 覆盖项 + 设置的库，
// 导出后再导入到空库，断言层级 / 类型 / 归属 / 覆盖项 / 设置都还原。
func TestBackupService_RoundTrip(t *testing.T) {
	ctx := context.Background()

	// ---- 源库：造数据 ----
	srcDB := testutil.NewTestDB(t)
	srcFolders := repository.NewFolderRepository(srcDB)
	srcFeeds := repository.NewFeedRepository(srcDB)
	srcSettings := repository.NewSettingsRepository(srcDB)
	srcPlugins := repository.NewPluginRepository(srcDB)
	srcMCP := repository.NewMCPServerRepository(srcDB)

	parent, err := srcFolders.Create(ctx, "Tech", nil, "picture")
	require.NoError(t, err)
	child, err := srcFolders.Create(ctx, "Go", &parent.ID, "social")
	require.NoError(t, err)

	// 子文件夹里的普通订阅（social 类型 + 自动摘要 + 代理覆盖）
	socialFeed, err := srcFeeds.Create(ctx, model.Feed{
		FolderID:   &child.ID,
		Title:      "Go Weekly",
		URL:        "https://go.example.com/rss",
		Type:       "social",
		SourceType: model.FeedSourceRSS,
		SiteURL:    strPtr("https://go.example.com"),
	})
	require.NoError(t, err)
	socialFeed.AutoSummary = boolPtr(true)
	socialFeed.ProxyMode = proxyModePtr(model.ProxyModeProxy)
	socialFeed.ProxyConfig = &model.ProxyOverrideConfig{Type: "http", Host: "127.0.0.1", Port: 8080, Username: "u", Password: "secret"}
	_, err = srcFeeds.Update(ctx, socialFeed)
	require.NoError(t, err)

	// 根级图片订阅
	_, err = srcFeeds.Create(ctx, model.Feed{Title: "Pics", URL: "https://pics.example.com/rss", Type: "picture", SourceType: model.FeedSourceRSS})
	require.NoError(t, err)

	// 父文件夹里的 MCP 订阅（带 mcp_config）
	mcpCfg := `{"url":"mcp://mcp.example.com/sse"}`
	_, err = srcFeeds.Create(ctx, model.Feed{
		FolderID:   &parent.ID,
		Title:      "MCP Feed",
		URL:        "mcp://mcp.example.com/sse",
		Type:       "article",
		SourceType: model.FeedSourceMCP,
		MCPConfig:  &mcpCfg,
	})
	require.NoError(t, err)

	// 设置（含一个凭证键，应被排除）
	require.NoError(t, srcSettings.Set(ctx, "ui.theme", "dark"))
	require.NoError(t, srcSettings.Set(ctx, "ai.api_key", "top-secret"))
	require.NoError(t, srcPlugins.Upsert(ctx, "com.example.plugin", true))
	_, err = srcMCP.Create(ctx, model.MCPServer{Name: "srv", URL: "mcp://mcp.example.com/sse", Transport: model.MCPTransportAuto})
	require.NoError(t, err)

	// ---- 导出 ----
	exporter := service.NewBackupService(srcFolders, srcFeeds, srcSettings, srcPlugins, srcMCP)
	payload, err := exporter.Export(ctx)
	require.NoError(t, err)

	var doc service.BackupDocument
	require.NoError(t, json.Unmarshal(payload, &doc))
	require.Equal(t, "krss-backup", doc.Format)
	require.Equal(t, 2, len(doc.Folders))
	require.Equal(t, 3, len(doc.Feeds))
	require.Contains(t, doc.Settings, "ui.theme")
	require.NotContains(t, doc.Settings, "ai.api_key", "凭证键必须排除")
	require.Len(t, doc.Plugins, 1)
	require.Len(t, doc.MCPServers, 1)

	// 导出给订阅的代理配置打了码（密码清空）。
	var exportedSocial service.BackupFeed
	for _, f := range doc.Feeds {
		if f.URL == "https://go.example.com/rss" {
			exportedSocial = f
		}
	}
	require.NotNil(t, exportedSocial.ProxyConfig)
	require.Empty(t, exportedSocial.ProxyConfig.Password, "备份不落代理密码")

	// ---- 导入到空库 ----
	dstDB := testutil.NewTestDB(t)
	dstFolders := repository.NewFolderRepository(dstDB)
	dstFeeds := repository.NewFeedRepository(dstDB)
	dstSettings := repository.NewSettingsRepository(dstDB)
	dstPlugins := repository.NewPluginRepository(dstDB)
	dstMCP := repository.NewMCPServerRepository(dstDB)

	importer := service.NewBackupService(dstFolders, dstFeeds, dstSettings, dstPlugins, dstMCP)
	result, err := importer.Import(ctx, bytes.NewReader(payload))
	require.NoError(t, err)
	require.Equal(t, 2, result.FoldersCreated)
	require.Equal(t, 3, result.FeedsCreated)
	require.Equal(t, 0, result.FeedsSkipped)
	require.Equal(t, 1, result.MCPServersCreated)

	// 文件夹层级 + 类型还原
	dstFolderList, err := dstFolders.List(ctx)
	require.NoError(t, err)
	byName := map[string]model.Folder{}
	for _, f := range dstFolderList {
		byName[f.Name] = f
	}
	require.Equal(t, "picture", byName["Tech"].Type)
	require.Equal(t, "social", byName["Go"].Type)
	require.NotNil(t, byName["Go"].ParentID)
	require.Equal(t, byName["Tech"].ID, *byName["Go"].ParentID)

	// 订阅：类型 / 来源 / 归属 / 覆盖项 / MCP 配置还原
	dstFeedList, err := dstFeeds.List(ctx, nil)
	require.NoError(t, err)
	byURL := map[string]model.Feed{}
	for _, f := range dstFeedList {
		byURL[f.URL] = f
	}

	social := byURL["https://go.example.com/rss"]
	require.Equal(t, "social", social.Type)
	require.Equal(t, model.FeedSourceRSS, social.SourceType)
	require.NotNil(t, social.FolderID)
	require.Equal(t, byName["Go"].ID, *social.FolderID)
	require.NotNil(t, social.AutoSummary)
	require.True(t, *social.AutoSummary)
	require.NotNil(t, social.ProxyMode)
	require.Equal(t, model.ProxyModeProxy, *social.ProxyMode)
	require.NotNil(t, social.ProxyConfig)
	require.Equal(t, "127.0.0.1", social.ProxyConfig.Host)
	require.Empty(t, social.ProxyConfig.Password, "密码不随备份还原")

	pics := byURL["https://pics.example.com/rss"]
	require.Equal(t, "picture", pics.Type)

	mcp := byURL["mcp://mcp.example.com/sse"]
	require.Equal(t, model.FeedSourceMCP, mcp.SourceType)
	require.NotNil(t, mcp.MCPConfig)
	require.Equal(t, `{"url":"mcp://mcp.example.com/sse"}`, *mcp.MCPConfig)
	require.NotNil(t, mcp.FolderID)
	require.Equal(t, byName["Tech"].ID, *mcp.FolderID)

	// 设置还原（凭证键不还原）
	theme, err := dstSettings.Get(ctx, "ui.theme")
	require.NoError(t, err)
	require.NotNil(t, theme)
	require.Equal(t, "dark", theme.Value)
	secret, err := dstSettings.Get(ctx, "ai.api_key")
	require.NoError(t, err)
	require.Nil(t, secret, "凭证键不应被导入")

	// 插件启停还原
	dstPluginsList, err := dstPlugins.List(ctx)
	require.NoError(t, err)
	require.Len(t, dstPluginsList, 1)
	require.Equal(t, "com.example.plugin", dstPluginsList[0].ID)
	require.True(t, dstPluginsList[0].Enabled)

	// MCP 连接还原（缺凭证默认禁用）
	dstMCPList, err := dstMCP.List(ctx)
	require.NoError(t, err)
	require.Len(t, dstMCPList, 1)
	require.Equal(t, "mcp://mcp.example.com/sse", dstMCPList[0].URL)
	require.False(t, dstMCPList[0].Enabled)

	// ---- 幂等：再导入一次全部跳过 ----
	result2, err := importer.Import(ctx, bytes.NewReader(payload))
	require.NoError(t, err)
	require.Equal(t, 0, result2.FoldersCreated)
	require.Equal(t, 0, result2.FeedsCreated)
	require.Equal(t, 3, result2.FeedsSkipped)
	require.Equal(t, 0, result2.MCPServersCreated)
}

func TestBackupService_Import_InvalidFormat(t *testing.T) {
	ctx := context.Background()
	db := testutil.NewTestDB(t)
	svc := service.NewBackupService(
		repository.NewFolderRepository(db),
		repository.NewFeedRepository(db),
		repository.NewSettingsRepository(db),
		repository.NewPluginRepository(db),
		repository.NewMCPServerRepository(db),
	)

	_, err := svc.Import(ctx, bytes.NewReader([]byte(`{"format":"not-krss","version":1}`)))
	require.ErrorIs(t, err, service.ErrInvalid)

	_, err = svc.Import(ctx, bytes.NewReader([]byte(`not json`)))
	require.ErrorIs(t, err, service.ErrInvalid)
}
