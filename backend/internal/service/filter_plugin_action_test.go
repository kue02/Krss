package service_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

// pluginActionFixture 与 filterFixture 同一套真库，只是把插件注册表接进 filter 引擎。
type pluginActionFixture struct {
	*filterFixture
	registry *plugin.Registry
}

func newPluginActionFixture(t *testing.T, registry *plugin.Registry) *pluginActionFixture {
	t.Helper()
	dbConn := testutil.NewTestDB(t)
	entryRepo := repository.NewEntryRepository(dbConn)
	feedRepo := repository.NewFeedRepository(dbConn)
	folderRepo := repository.NewFolderRepository(dbConn)
	filterRepo := repository.NewFilterRepository(dbConn)

	svc := service.NewFilterService(service.FilterServiceDeps{
		Filters: filterRepo,
		Entries: entryRepo,
		Feeds:   feedRepo,
		Folders: folderRepo,
		Plugins: registry,
	})

	return &pluginActionFixture{
		filterFixture: &filterFixture{
			db:      dbConn,
			service: svc,
			entries: entryRepo,
			feeds:   feedRepo,
			filters: filterRepo,
		},
		registry: registry,
	}
}

// demo 插件（动作 log）注册进真注册表：规则里引用它 → 引擎异步派给执行器。
func newDemoPluginRegistry(t *testing.T, execute func(plugin.ActionRequest) error) *plugin.Registry {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(fakePluginWithAction{
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "log", execute: execute},
	}))
	return registry
}

// 55-10：规则里存插件动作引用 → 引擎 dispatch 到插件执行器。
func TestApplyToEntries_DispatchesPluginAction(t *testing.T) {
	fired := make(chan plugin.ActionRequest, 1)
	registry := newDemoPluginRegistry(t, func(req plugin.ActionRequest) error {
		fired <- req
		return nil
	})

	fixture := newPluginActionFixture(t, registry)
	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-plugin-1", "krss 发布", timePtr(time.Now()))

	svc := fixture.service
	_, err := svc.Create(context.Background(), service.FilterWriteParams{
		Name:       "推送到手机（插件）",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "krss"}},
		Actions: model.FilterActions{PluginActions: []model.PluginActionRef{{
			Plugin: "demo", Action: "log", Config: map[string]string{"note": "hello"},
		}}},
	})
	require.NoError(t, err)

	applied, err := svc.ApplyToEntries(context.Background(), feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 1, applied)

	select {
	case req := <-fired:
		require.Equal(t, "hello", req.Config["note"])
		require.NotNil(t, req.Entry.Title)
		require.Equal(t, "krss 发布", *req.Entry.Title)
		require.Equal(t, "推送到手机（插件）", req.Filter.Name)
		require.Equal(t, feed.ID, req.Feed.ID)
	case <-time.After(2 * time.Second):
		t.Fatal("2 秒内没收到插件动作执行")
	}
}

// 插件动作执行失败：原因写进规则 last_error（可见，不静默）；下一次成功要把这条错误清掉。
// （55-13 从旧的 dispatchNotify 用例搬来的语义：出网动作失败必须留痕、成功必须清痕。）
func TestApplyToEntries_PluginActionFailureWritesLastErrorThenSuccessClears(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	registry := newDemoPluginRegistry(t, func(plugin.ActionRequest) error {
		if fail.Load() {
			return errors.New("HTTP 500 boom（目标 api.day.app）")
		}
		return nil
	})

	fixture := newPluginActionFixture(t, registry)
	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-plugin-3", "krss 会失败", timePtr(time.Now()))

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "插件会报错的规则",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "krss"}},
		Actions: model.FilterActions{PluginActions: []model.PluginActionRef{{
			Plugin: "demo", Action: "log",
		}}},
	})

	ctx := context.Background()
	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError != nil
	}, 3*time.Second, 20*time.Millisecond, "插件动作失败要写进 last_error")

	got, err := fixture.filters.GetByID(ctx, rule.ID)
	require.NoError(t, err)
	require.Contains(t, *got.LastError, "插件动作失败：")
	require.Contains(t, *got.LastError, "HTTP 500 boom", "下游原因要带回来（用户才知道为什么没推出去）")

	// 修好之后再命中一次：上一次插件留的错要被清掉
	fail.Store(false)
	entry2 := fixture.seedEntry(t, feed.ID, "h-plugin-4", "krss 这次成功", timePtr(time.Now()))
	_, err = fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry2})
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError == nil
	}, 3*time.Second, 20*time.Millisecond, "成功一次要清掉自己上次留的原因")
}

// 插件停用：不执行，且把原因写进规则 last_error（可见，不静默）。
func TestApplyToEntries_PluginDisabledWritesLastError(t *testing.T) {
	executed := make(chan struct{}, 1)
	registry := newDemoPluginRegistry(t, func(plugin.ActionRequest) error {
		executed <- struct{}{}
		return nil
	})
	registry.LoadEnabled(map[string]bool{"demo": false})

	fixture := newPluginActionFixture(t, registry)
	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-plugin-2", "krss 停用", timePtr(time.Now()))

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "停用插件的规则",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "krss"}},
		Actions: model.FilterActions{PluginActions: []model.PluginActionRef{{
			Plugin: "demo", Action: "log",
		}}},
	})

	applied, err := fixture.service.ApplyToEntries(context.Background(), feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 1, applied)

	ctx := context.Background()
	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError != nil
	}, 2*time.Second, 20*time.Millisecond, "停用插件要写进 last_error")

	got, err := fixture.filters.GetByID(ctx, rule.ID)
	require.NoError(t, err)
	require.NotNil(t, got.LastError)
	require.Contains(t, *got.LastError, "插件动作失败：")
	require.Contains(t, *got.LastError, "插件 demo 已停用")

	select {
	case <-executed:
		t.Fatal("停用的插件不该被执行")
	case <-time.After(200 * time.Millisecond):
	}
}
