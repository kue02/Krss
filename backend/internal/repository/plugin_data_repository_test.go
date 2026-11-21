package repository_test

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
)

// TestPluginDataRepository_RoundTripAndOverwrite 往返 + 覆盖写：
// 同 (plugin, collection, key) 再 Put 是更新（值换、行数不变），别的插件/collection 互不干扰。
func TestPluginDataRepository_RoundTripAndOverwrite(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginDataRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Put(ctx, "rsshub", "kv", "probe", `{"ok":true}`))

	value, err := repo.Get(ctx, "rsshub", "kv", "probe")
	require.NoError(t, err)
	require.Equal(t, `{"ok":true}`, value)

	// 覆盖写：不是插新行。
	require.NoError(t, repo.Put(ctx, "rsshub", "kv", "probe", `{"ok":false}`))
	value, err = repo.Get(ctx, "rsshub", "kv", "probe")
	require.NoError(t, err)
	require.Equal(t, `{"ok":false}`, value)

	count, err := repo.Count(ctx, "rsshub")
	require.NoError(t, err)
	require.Equal(t, 1, count, "覆盖写不许变成两行")

	// 同名 collection / 同键名在不同插件里是两回事。
	require.NoError(t, repo.Put(ctx, "bark", "kv", "probe", `"bark"`))
	value, err = repo.Get(ctx, "bark", "kv", "probe")
	require.NoError(t, err)
	require.Equal(t, `"bark"`, value)

	// 不存在的键：仓储哨兵 ErrNotFound（service 靠它回 404）。
	_, err = repo.Get(ctx, "rsshub", "kv", "ghost")
	require.ErrorIs(t, err, repository.ErrNotFound)

	// 删掉后再读也 404；重复删同一个键同样 404（要删的东西不在了）。
	require.NoError(t, repo.Delete(ctx, "rsshub", "kv", "probe"))
	_, err = repo.Get(ctx, "rsshub", "kv", "probe")
	require.ErrorIs(t, err, repository.ErrNotFound)
	require.ErrorIs(t, repo.Delete(ctx, "rsshub", "kv", "probe"), repository.ErrNotFound)
}

// TestPluginDataRepository_ListByPrefix 前缀列举：只要这个 collection 里以 prefix 开头的键，
// 按 key 升序、限条数；别的 collection 与别的插件不串味。
func TestPluginDataRepository_ListByPrefix(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginDataRepository(db)
	ctx := context.Background()

	for _, key := range []string{"feed:1", "feed:2", "feed:3", "other"} {
		require.NoError(t, repo.Put(ctx, "demo", "cache", key, `"`+key+`"`))
	}
	require.NoError(t, repo.Put(ctx, "demo", "other-coll", "feed:9", `"x"`))
	require.NoError(t, repo.Put(ctx, "bark", "cache", "feed:9", `"y"`))

	got, err := repo.List(ctx, "demo", "cache", "feed:", 10)
	require.NoError(t, err)
	require.Equal(t, map[string]string{
		"feed:1": `"feed:1"`,
		"feed:2": `"feed:2"`,
		"feed:3": `"feed:3"`,
	}, got)

	// 空 prefix = 整个 collection。
	got, err = repo.List(ctx, "demo", "cache", "", 10)
	require.NoError(t, err)
	require.Len(t, got, 4)

	// limit 生效（按 key 升序取前 N 条）。
	got, err = repo.List(ctx, "demo", "cache", "", 2)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"feed:1": `"feed:1"`, "feed:2": `"feed:2"`}, got)

	// limit 缺省 / 超上限都收敛到边界值（默认 200、上限 1000），不报错。
	got, err = repo.List(ctx, "demo", "cache", "", 0)
	require.NoError(t, err)
	require.Len(t, got, 4)
	got, err = repo.List(ctx, "demo", "cache", "", 99999)
	require.NoError(t, err)
	require.Len(t, got, 4)
}

// TestPluginDataRepository_DeleteCollection 删整个 collection：只清这一个插件的这一个 collection，
// 别的 collection / 别的插件一条不动；空 collection 删了也不报错（幂等）。
func TestPluginDataRepository_DeleteCollection(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginDataRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Put(ctx, "demo", "cache", "a", `"1"`))
	require.NoError(t, repo.Put(ctx, "demo", "cache", "b", `"2"`))
	require.NoError(t, repo.Put(ctx, "demo", "keep", "a", `"3"`))
	require.NoError(t, repo.Put(ctx, "bark", "cache", "a", `"4"`))

	require.NoError(t, repo.DeleteCollection(ctx, "demo", "cache"))

	count, err := repo.Count(ctx, "demo")
	require.NoError(t, err)
	require.Equal(t, 1, count, "只清 demo 的 cache，keep 还在")

	value, err := repo.Get(ctx, "demo", "keep", "a")
	require.NoError(t, err)
	require.Equal(t, `"3"`, value)

	value, err = repo.Get(ctx, "bark", "cache", "a")
	require.NoError(t, err)
	require.Equal(t, `"4"`, value)

	// 再删一次（已经空了）不报错。
	require.NoError(t, repo.DeleteCollection(ctx, "demo", "cache"))

	// Count 按插件算全部 collection。
	require.NoError(t, repo.DeleteCollection(ctx, "demo", "keep"))
	count, err = repo.Count(ctx, "demo")
	require.NoError(t, err)
	require.Zero(t, count)
}

// TestPluginDataRepository_RejectsOversizedAndIllegal 仓储自己也挡脏数据（service 挡完还要挡一道：
// 插件 socket 通道、脚本直接调仓储的路径也灌不进去）。
func TestPluginDataRepository_RejectsOversizedAndIllegal(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginDataRepository(db)
	ctx := context.Background()

	// 单值上限 256KB（字节）。
	tooBig := strings.Repeat("a", repository.PluginDataMaxValueBytes+1)
	require.ErrorIs(t, repo.Put(ctx, "demo", "kv", "big", tooBig), repository.ErrPluginDataValueTooLarge)
	// 正好到上限要能写。
	require.NoError(t, repo.Put(ctx, "demo", "kv", "edge", strings.Repeat("a", repository.PluginDataMaxValueBytes)))

	// collection 名：小写字母/数字/_/-，1..32 位。
	for _, bad := range []string{"", "Upper", "with space", "中文", "a/b", strings.Repeat("a", 33)} {
		require.ErrorIs(t, repo.Put(ctx, "demo", bad, "k", `"v"`), repository.ErrPluginDataInvalidCollection, "collection=%q", bad)
		_, err := repo.Get(ctx, "demo", bad, "k")
		require.ErrorIs(t, err, repository.ErrPluginDataInvalidCollection, "collection=%q", bad)
	}
	require.NoError(t, repo.Put(ctx, "demo", "ok-coll_1", "k", `"v"`))

	// key：1..200 字节。
	require.ErrorIs(t, repo.Put(ctx, "demo", "kv", "", `"v"`), repository.ErrPluginDataInvalidKey)
	require.ErrorIs(t, repo.Put(ctx, "demo", "kv", strings.Repeat("k", repository.PluginDataMaxKeyBytes+1), `"v"`), repository.ErrPluginDataInvalidKey)
	require.NoError(t, repo.Put(ctx, "demo", "kv", strings.Repeat("k", repository.PluginDataMaxKeyBytes), `"v"`))
}

// TestPluginDataRepository_DeleteAll 按插件删全部 collection（卸载清残留）：
// 只清这个插件的所有 collection，别的插件一条不动；返回受影响行数；空插件删了是 0,nil（幂等）。
func TestPluginDataRepository_DeleteAll(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginDataRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Put(ctx, "demo", "cache", "a", `"1"`))
	require.NoError(t, repo.Put(ctx, "demo", "cache", "b", `"2"`))
	require.NoError(t, repo.Put(ctx, "demo", "keep", "a", `"3"`))
	require.NoError(t, repo.Put(ctx, "bark", "cache", "a", `"4"`))

	n, err := repo.DeleteAll(ctx, "demo")
	require.NoError(t, err)
	require.EqualValues(t, 3, n, "demo 两个 collection 共 3 行全删")

	count, err := repo.Count(ctx, "demo")
	require.NoError(t, err)
	require.Zero(t, count)

	// 别的插件不受影响。
	value, err := repo.Get(ctx, "bark", "cache", "a")
	require.NoError(t, err)
	require.Equal(t, `"4"`, value)

	// 再删一次（已经空了）：0 行、不报错。
	n, err = repo.DeleteAll(ctx, "demo")
	require.NoError(t, err)
	require.Zero(t, n)
}
