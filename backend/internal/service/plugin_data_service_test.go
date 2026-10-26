package service_test

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/service"
)

// fakePluginDataRepo 内存版插件数据仓储（service 用例只验校验与错误翻译，不验 SQL）。
type fakePluginDataRepo struct {
	rows map[string]string
	// lastLimit 记下 List 收到的 limit（service 要在仓储之前收敛边界）。
	lastLimit int
}

func newFakePluginDataRepo() *fakePluginDataRepo {
	return &fakePluginDataRepo{rows: make(map[string]string)}
}

func fakePluginDataKey(pluginID, collection, key string) string {
	return pluginID + "\x00" + collection + "\x00" + key
}

func (r *fakePluginDataRepo) Get(_ context.Context, pluginID, collection, key string) (string, error) {
	value, ok := r.rows[fakePluginDataKey(pluginID, collection, key)]
	if !ok {
		return "", repository.ErrNotFound
	}
	return value, nil
}

func (r *fakePluginDataRepo) Put(_ context.Context, pluginID, collection, key, value string) error {
	r.rows[fakePluginDataKey(pluginID, collection, key)] = value
	return nil
}

func (r *fakePluginDataRepo) Delete(_ context.Context, pluginID, collection, key string) error {
	k := fakePluginDataKey(pluginID, collection, key)
	if _, ok := r.rows[k]; !ok {
		return repository.ErrNotFound
	}
	delete(r.rows, k)
	return nil
}

func (r *fakePluginDataRepo) List(_ context.Context, pluginID, collection, prefix string, limit int) (map[string]string, error) {
	r.lastLimit = limit
	out := make(map[string]string)
	head := fakePluginDataKey(pluginID, collection, "")
	for k, v := range r.rows {
		if !strings.HasPrefix(k, head) {
			continue
		}
		key := strings.TrimPrefix(k, head)
		if strings.HasPrefix(key, prefix) {
			out[key] = v
		}
	}
	return out, nil
}

func (r *fakePluginDataRepo) DeleteCollection(_ context.Context, pluginID, collection string) error {
	head := fakePluginDataKey(pluginID, collection, "")
	for k := range r.rows {
		if strings.HasPrefix(k, head) {
			delete(r.rows, k)
		}
	}
	return nil
}

func (r *fakePluginDataRepo) Count(_ context.Context, pluginID string) (int, error) {
	n := 0
	for k := range r.rows {
		if strings.HasPrefix(k, pluginID+"\x00") {
			n++
		}
	}
	return n, nil
}

// newPluginDataService 起一个带「data」插件的真注册表 + 真 service（数据仓储用内存假件）。
func newPluginDataService(t *testing.T) (service.PluginService, *plugin.Registry, *fakePluginDataRepo) {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(fakePluginWithAction{
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "log"},
	}))
	repo := newFakePluginDataRepo()
	svc := service.NewPluginService(registry, newFakePluginRepo(), nil, service.WithPluginDataRepo(repo))
	return svc, registry, repo
}

// TestPluginData_RoundTrip 往返：写进去能读出来；同一个键再写是覆盖；删掉后 404；
// 删整 collection 只清那一个插件的那个 collection。
func TestPluginData_RoundTrip(t *testing.T) {
	svc, _, repo := newPluginDataService(t)
	ctx := context.Background()

	require.NoError(t, svc.PutData(ctx, "demo", "kv", "probe", `{"ok":true}`))
	value, err := svc.GetData(ctx, "demo", "kv", "probe")
	require.NoError(t, err)
	require.Equal(t, `{"ok":true}`, value)

	// 覆盖写：一行、新值。
	require.NoError(t, svc.PutData(ctx, "demo", "kv", "probe", `{"ok":false}`))
	value, err = svc.GetData(ctx, "demo", "kv", "probe")
	require.NoError(t, err)
	require.Equal(t, `{"ok":false}`, value)
	require.Len(t, repo.rows, 1, "覆盖写不许插新行")

	// 列举：前缀过滤 + limit 收敛。
	require.NoError(t, svc.PutData(ctx, "demo", "kv", "other", `"x"`))
	values, err := svc.ListData(ctx, "demo", "kv", "", 0)
	require.NoError(t, err)
	require.Len(t, values, 2)
	require.Equal(t, repository.PluginDataDefaultLimit, repo.lastLimit, "limit 缺省 = 200（仓储也收敛，service 先给准值）")

	values, err = svc.ListData(ctx, "demo", "kv", "pro", 5)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"probe": `{"ok":false}`}, values)

	// 单个删除；再删同一个键 = 404（要删的东西不在了）。
	require.NoError(t, svc.DeleteData(ctx, "demo", "kv", "probe"))
	_, err = svc.GetData(ctx, "demo", "kv", "probe")
	require.ErrorIs(t, err, service.ErrNotFound)
	require.ErrorIs(t, svc.DeleteData(ctx, "demo", "kv", "probe"), service.ErrNotFound)

	// 删整 collection（幂等）。
	require.NoError(t, svc.DeleteDataCollection(ctx, "demo", "kv"))
	count, err := repo.Count(ctx, "demo")
	require.NoError(t, err)
	require.Zero(t, count)
	require.NoError(t, svc.DeleteDataCollection(ctx, "demo", "kv"))
}

// TestPluginData_Validation 越界一律 ErrInvalid（HTTP 400）：collection 名、键长、单值大小、limit 上限。
func TestPluginData_Validation(t *testing.T) {
	svc, _, _ := newPluginDataService(t)
	ctx := context.Background()

	// collection：^[a-z0-9_-]{1,32}$
	for _, bad := range []string{"", "Upper", "bad name", "中文", "a/b", strings.Repeat("a", 33)} {
		require.ErrorIs(t, svc.PutData(ctx, "demo", bad, "k", `"v"`), service.ErrInvalid, "collection=%q", bad)
		_, err := svc.GetData(ctx, "demo", bad, "k")
		require.ErrorIs(t, err, service.ErrInvalid)
		_, err = svc.ListData(ctx, "demo", bad, "", 0)
		require.ErrorIs(t, err, service.ErrInvalid)
		require.ErrorIs(t, svc.DeleteDataCollection(ctx, "demo", bad), service.ErrInvalid)
	}
	// 合法边界：32 位、含 _ 与 -
	require.NoError(t, svc.PutData(ctx, "demo", strings.Repeat("a", 32), "k", `"v"`))
	require.NoError(t, svc.PutData(ctx, "demo", "ok_coll-1", "k", `"v"`))

	// key：1..200 字节
	require.ErrorIs(t, svc.PutData(ctx, "demo", "kv", "", `"v"`), service.ErrInvalid)
	require.ErrorIs(t, svc.PutData(ctx, "demo", "kv", strings.Repeat("k", repository.PluginDataMaxKeyBytes+1), `"v"`), service.ErrInvalid)
	require.NoError(t, svc.PutData(ctx, "demo", "kv", strings.Repeat("k", repository.PluginDataMaxKeyBytes), `"v"`))

	// 单值 ≤ 256KB
	require.ErrorIs(t, svc.PutData(ctx, "demo", "kv", "big", strings.Repeat("a", repository.PluginDataMaxValueBytes+1)), service.ErrInvalid)
	require.NoError(t, svc.PutData(ctx, "demo", "kv", "edge", strings.Repeat("a", repository.PluginDataMaxValueBytes)))
}

// TestPluginData_LimitClamped limit 边界在 service 就收敛好再交给仓储。
func TestPluginData_LimitClamped(t *testing.T) {
	svc, _, repo := newPluginDataService(t)
	ctx := context.Background()

	_, err := svc.ListData(ctx, "demo", "kv", "", 99999)
	require.NoError(t, err)
	require.Equal(t, repository.PluginDataMaxLimit, repo.lastLimit)

	_, err = svc.ListData(ctx, "demo", "kv", "", -3)
	require.NoError(t, err)
	require.Equal(t, repository.PluginDataDefaultLimit, repo.lastLimit)
}

// TestPluginData_PluginNotFoundOrDisabled 插件不存在 = ErrPluginNotFound（404）；
// 停用 = ErrPluginDisabled（409）—— 停用的插件不该还能读写自己的数据。
func TestPluginData_PluginNotFoundOrDisabled(t *testing.T) {
	svc, registry, _ := newPluginDataService(t)
	ctx := context.Background()

	require.ErrorIs(t, svc.PutData(ctx, "ghost", "kv", "k", `"v"`), service.ErrPluginNotFound)
	_, err := svc.GetData(ctx, "ghost", "kv", "k")
	require.ErrorIs(t, err, service.ErrPluginNotFound)
	_, err = svc.ListData(ctx, "ghost", "kv", "", 0)
	require.ErrorIs(t, err, service.ErrPluginNotFound)
	require.ErrorIs(t, svc.DeleteData(ctx, "ghost", "kv", "k"), service.ErrPluginNotFound)
	require.ErrorIs(t, svc.DeleteDataCollection(ctx, "ghost", "kv"), service.ErrPluginNotFound)

	require.True(t, registry.SetEnabled("demo", false))
	require.ErrorIs(t, svc.PutData(ctx, "demo", "kv", "k", `"v"`), service.ErrPluginDisabled)
	_, err = svc.GetData(ctx, "demo", "kv", "k")
	require.ErrorIs(t, err, service.ErrPluginDisabled)
}

// TestPluginData_StorageNotConfigured 没挂数据仓储（老测试 / 精简部署）时给一个明确的 500，
// 不许 panic，也不许假装写成功了。
func TestPluginData_StorageNotConfigured(t *testing.T) {
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(fakePluginWithAction{
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "log"},
	}))
	svc := service.NewPluginService(registry, newFakePluginRepo(), nil)
	ctx := context.Background()

	err := svc.PutData(ctx, "demo", "kv", "k", `"v"`)
	require.ErrorIs(t, err, service.ErrPluginDataUnavailable)
}
