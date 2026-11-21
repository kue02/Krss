package service_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

// TestUninstall_ExternalPluginCleansUp 外部插件卸载：目录改名归档（原路径消失、.removed-* 在）、
// plugin_data 清空、plugin.<id>.* 设置清空、plugins 行删除、返回清单不含它；Ensure 不会立刻把它扫回来。
func TestUninstall_ExternalPluginCleansUp(t *testing.T) {
	db := testutil.NewTestDB(t)
	pluginRepo := repository.NewPluginRepository(db)
	dataRepo := repository.NewPluginDataRepository(db)
	settingsRepo := repository.NewSettingsRepository(db)
	reg := plugin.NewRegistry()

	pluginsDir := t.TempDir()
	id := "ext1"
	dir := filepath.Join(pluginsDir, id)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	manifest := `{"id":"ext1","name":"外部插件","version":"1.0.0","transport":"http","entrypoint":"./ext1","autostart":false}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644))

	host := service.NewPluginHost(reg, pluginRepo, pluginsDir,
		service.WithPluginReadyTimeout(2*time.Second),
		service.WithPluginBackoff(20*time.Millisecond, 200*time.Millisecond),
		service.WithPluginStopGrace(time.Second),
	)
	t.Cleanup(host.Stop)
	svc := service.NewPluginService(reg, pluginRepo, settingsRepo,
		service.WithPluginHost(host), service.WithPluginDataRepo(dataRepo))
	ctx := context.Background()

	// Catalog：发现外部插件（停用态注册 manifest 空壳）、落库。
	items, err := svc.Catalog(ctx)
	require.NoError(t, err)
	require.True(t, hasCatalogItem(items, id), "卸载前清单里应有它")

	// 造残留：plugin_data + plugin.<id>.* 设置。
	require.NoError(t, dataRepo.Put(ctx, id, "kv", "k", `"v"`))
	require.NoError(t, dataRepo.Put(ctx, id, "cache", "c", `"w"`))
	require.NoError(t, settingsRepo.Set(ctx, "plugin.ext1.url", "https://example.com"))
	require.NoError(t, settingsRepo.Set(ctx, "plugin.ext1.token", "secret"))

	items, err = svc.Uninstall(ctx, id)
	require.NoError(t, err)
	require.False(t, hasCatalogItem(items, id), "卸载后清单不含它")

	// 目录：原路径消失，.removed-* 归档在。
	_, statErr := os.Stat(dir)
	require.True(t, os.IsNotExist(statErr), "原插件目录应消失")
	archives, err := filepath.Glob(dir + ".removed-*")
	require.NoError(t, err)
	require.Len(t, archives, 1, "应留下一个 .removed-* 归档目录")

	// plugin_data 清空。
	count, err := dataRepo.Count(ctx, id)
	require.NoError(t, err)
	require.Zero(t, count)

	// plugin.<id>.* 设置清空。
	left, err := settingsRepo.GetByPrefix(ctx, "plugin.ext1.")
	require.NoError(t, err)
	require.Empty(t, left)

	// plugins 行删除。
	states, err := pluginRepo.List(ctx)
	require.NoError(t, err)
	for _, st := range states {
		require.NotEqual(t, id, st.ID, "plugins 行应已删除")
	}

	// Ensure 不会立刻把它重新扫回来（改名后已不在 <id>）。
	require.NoError(t, host.Ensure(ctx))
	require.False(t, host.Has(id), "归档后宿主不应再认领该 id")
}

// TestUninstall_BuiltinRejected 内置插件不可卸载：返回 ErrPluginBuiltinCannotUninstall；
// 不存在的插件返回 ErrPluginNotFound（卸载不存在的插件是错误，不静默成功）。
func TestUninstall_BuiltinRejected(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	require.NoError(t, reg.Register(fakePluginWithAction{
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "log"},
	}))
	svc := service.NewPluginService(reg, fakeReg, newSettingsStub())
	ctx := context.Background()

	_, err := svc.Uninstall(ctx, "demo")
	require.ErrorIs(t, err, service.ErrPluginBuiltinCannotUninstall)

	_, err = svc.Uninstall(ctx, "ghost")
	require.ErrorIs(t, err, service.ErrPluginNotFound)
}

func hasCatalogItem(items []plugin.CatalogItem, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

// TestUninstall_RetryAfterArchiveSucceeds 审查 MEDIUM-2：归档成功但后续 DB 清理失败后，
// 重试时注册表/宿主都已不认这个 id，只要 plugins 行还在，就必须继续幂等清理而不是回 404。
func TestUninstall_RetryAfterArchiveSucceeds(t *testing.T) {
	db := testutil.NewTestDB(t)
	pluginRepo := repository.NewPluginRepository(db)
	dataRepo := repository.NewPluginDataRepository(db)
	settingsRepo := repository.NewSettingsRepository(db)
	reg := plugin.NewRegistry()

	pluginsDir := t.TempDir()
	id := "ext-retry"
	dir := filepath.Join(pluginsDir, id)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	manifest := `{"id":"ext-retry","name":"外部插件","version":"1.0.0","transport":"http","entrypoint":"./ext-retry","autostart":false}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644))

	host := service.NewPluginHost(reg, pluginRepo, pluginsDir)
	t.Cleanup(host.Stop)
	svc := service.NewPluginService(reg, pluginRepo, settingsRepo,
		service.WithPluginHost(host), service.WithPluginDataRepo(dataRepo))
	ctx := context.Background()

	items, err := svc.Catalog(ctx)
	require.NoError(t, err)
	require.True(t, hasCatalogItem(items, id))

	require.NoError(t, dataRepo.Put(ctx, id, "kv", "k", `"v"`))
	require.NoError(t, settingsRepo.Set(ctx, "plugin.ext-retry.url", "https://example.com"))

	// 模拟第一次卸载：目录已归档、注册表已摘，但清 DB 失败（这里直接先做归档）。
	_, err = host.Archive(id)
	require.NoError(t, err)
	require.False(t, host.Has(id), "归档后宿主不再认领")

	// 重试：注册表/宿主都没有它，但 plugins 行还在 ⇒ 继续清理，不能 404。
	items, err = svc.Uninstall(ctx, id)
	require.NoError(t, err)
	require.False(t, hasCatalogItem(items, id))

	count, err := dataRepo.Count(ctx, id)
	require.NoError(t, err)
	require.Zero(t, count)
	left, err := settingsRepo.GetByPrefix(ctx, "plugin.ext-retry.")
	require.NoError(t, err)
	require.Empty(t, left)
	states, err := pluginRepo.List(ctx)
	require.NoError(t, err)
	for _, st := range states {
		require.NotEqual(t, id, st.ID)
	}
}
