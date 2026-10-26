package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// invokeAction 同时实现 plugin.Action 与 plugin.Invoker：把收到的请求记下来，用例据此断言上下文裁剪。
type invokeAction struct {
	id  string
	got *plugin.InvokeRequest
	err error
}

func (a *invokeAction) ID() string             { return a.id }
func (a *invokeAction) Label() string          { return "界面直调" }
func (a *invokeAction) Fields() []plugin.Field { return nil }
func (a *invokeAction) Execute(context.Context, plugin.ActionRequest) error {
	return nil
}
func (a *invokeAction) Invoke(_ context.Context, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	if a.got != nil {
		*a.got = req
	}
	if a.err != nil {
		return plugin.InvokeResult{}, a.err
	}
	return plugin.InvokeResult{Message: "ok"}, nil
}

// invokePlugin 声明动作 + 界面贡献；contribution 决定「这个动作在哪些 surface 上可点」。
type invokePlugin struct {
	meta          plugin.Meta
	actions       []plugin.Action
	contributions []plugin.Contribution
}

func (p *invokePlugin) Meta() plugin.Meta                          { return p.meta }
func (p *invokePlugin) Actions() []plugin.Action                   { return p.actions }
func (p *invokePlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p *invokePlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p *invokePlugin) FetchClassifiers() []plugin.FetchClassifier {
	return nil
}
func (p *invokePlugin) Contributions() []plugin.Contribution { return p.contributions }

// invokeEntryRepo 只实现 GetByID 的条目读端（nil 值条目 = 取不到）。
type invokeEntryRepo struct {
	entries map[int64]model.Entry
}

func (r *invokeEntryRepo) GetByID(_ context.Context, id int64) (model.Entry, error) {
	entry, ok := r.entries[id]
	if !ok {
		return model.Entry{}, errors.New("entry not found")
	}
	return entry, nil
}

type invokeFeedRepo struct {
	feeds map[int64]model.Feed
}

func (r *invokeFeedRepo) GetByID(_ context.Context, id int64) (model.Feed, error) {
	feed, ok := r.feeds[id]
	if !ok {
		return model.Feed{}, errors.New("feed not found")
	}
	return feed, nil
}

type invokeFilterRepo struct {
	filters map[int64]model.Filter
}

func (r *invokeFilterRepo) GetByID(_ context.Context, id int64) (model.Filter, error) {
	filter, ok := r.filters[id]
	if !ok {
		return model.Filter{}, errors.New("filter not found")
	}
	return filter, nil
}

// newInvokeService 真注册表 + 真 service，读端按用例给（nil = 不挂）。
func newInvokeService(t *testing.T, p *invokePlugin, entries *invokeEntryRepo, feeds *invokeFeedRepo, filters *invokeFilterRepo) service.PluginService {
	t.Helper()
	reg := plugin.NewRegistry()
	require.NoError(t, reg.Register(p))
	return service.NewPluginService(reg, newFakePluginRepo(), newSettingsStub(),
		service.WithInvokeRepos(entries, feeds, filters))
}

// TestPluginService_Invoke 界面直调一个插件动作：上下文按插件声明的权限裁剪（56-5）。
func TestPluginService_Invoke(t *testing.T) {
	ctx := context.Background()

	t.Run("正常调用补齐上下文", func(t *testing.T) {
		var got plugin.InvokeRequest
		action := &invokeAction{id: "open", got: &got}
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
			actions: []plugin.Action{action},
			contributions: []plugin.Contribution{{
				ID: "demo-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open",
				Label: "用 Demo 打开", Selection: plugin.SelectionSingle,
			}},
		}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			10: {ID: 10, FeedID: 1, Title: stringPtr("标题"), Content: stringPtr("全文")},
		}}
		feeds := &invokeFeedRepo{feeds: map[int64]model.Feed{1: {ID: 1, Title: "订阅"}}}
		svc := newInvokeService(t, p, entries, feeds, nil)

		result, err := svc.Invoke(ctx, "demo", "open", plugin.InvokeRequest{
			Surface:   plugin.SurfaceEntryContextMenu,
			Selection: plugin.Selection{EntryIDs: []int64{10}, FeedIDs: []int64{1}},
		})
		require.NoError(t, err)
		require.Equal(t, "ok", result.Message)
		require.Equal(t, plugin.SurfaceEntryContextMenu, got.Surface, "surface 要原样透传")
		require.Equal(t, "demo", got.Plugin)
		require.Equal(t, "open", got.Action)
		require.Len(t, got.Entries, 1, "内置插件不裁剪 ⇒ 条目明细要补上")
		require.Equal(t, int64(10), got.Entries[0].ID)
		require.NotNil(t, got.Entries[0].Content)
		require.Len(t, got.Feeds, 1)
		require.Equal(t, int64(1), got.Feeds[0].ID)
	})

	t.Run("条目右键只有 entryIds 也要反推订阅", func(t *testing.T) {
		var got plugin.InvokeRequest
		action := &invokeAction{id: "open", got: &got}
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
			actions: []plugin.Action{action},
			contributions: []plugin.Contribution{{
				ID: "demo-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open",
				Label: "用 Demo 打开", Selection: plugin.SelectionSingle,
			}},
		}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			10: {ID: 10, FeedID: 1, Title: stringPtr("标题")},
		}}
		feeds := &invokeFeedRepo{feeds: map[int64]model.Feed{1: {ID: 1, Title: "订阅"}}}
		svc := newInvokeService(t, p, entries, feeds, nil)

		_, err := svc.Invoke(ctx, "demo", "open", plugin.InvokeRequest{
			Surface:   plugin.SurfaceEntryContextMenu,
			Selection: plugin.Selection{EntryIDs: []int64{10}},
		})
		require.NoError(t, err)
		require.Len(t, got.Feeds, 1, "没给 feedIds 时要按条目的 FeedID 反推，否则插件拿不到来源名")
		require.Equal(t, int64(1), got.Feeds[0].ID)
	})

	t.Run("插件停用", func(t *testing.T) {
		action := &invokeAction{id: "open"}
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
			actions: []plugin.Action{action},
			contributions: []plugin.Contribution{{
				ID: "demo-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open", Label: "打开",
			}},
		}
		reg := plugin.NewRegistry()
		require.NoError(t, reg.Register(p))
		require.True(t, reg.SetEnabled("demo", false))
		svc := service.NewPluginService(reg, newFakePluginRepo(), newSettingsStub())

		_, err := svc.Invoke(ctx, "demo", "open", plugin.InvokeRequest{Surface: plugin.SurfaceEntryContextMenu})
		require.ErrorIs(t, err, service.ErrPluginDisabled)
	})

	t.Run("动作不存在", func(t *testing.T) {
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
			actions: []plugin.Action{&invokeAction{id: "open"}},
		}
		svc := newInvokeService(t, p, nil, nil, nil)

		_, err := svc.Invoke(ctx, "demo", "ghost", plugin.InvokeRequest{Surface: plugin.SurfaceEntryContextMenu})
		require.ErrorIs(t, err, service.ErrPluginActionNotFound)
	})

	t.Run("动作未实现 Invoker", func(t *testing.T) {
		// fakeAction 只有 Execute/Test，没有 Invoke ⇒ 界面不可直调。
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "legacy", Name: "Legacy", Builtin: true},
			actions: []plugin.Action{fakeAction{id: "log"}},
			contributions: []plugin.Contribution{{
				ID: "legacy-log", Surface: plugin.SurfaceSettingsSection, Action: "log", Label: "记录",
			}},
		}
		svc := newInvokeService(t, p, nil, nil, nil)

		_, err := svc.Invoke(ctx, "legacy", "log", plugin.InvokeRequest{Surface: plugin.SurfaceSettingsSection})
		require.ErrorIs(t, err, service.ErrPluginActionNotInvokable)
	})

	t.Run("surface 未声明", func(t *testing.T) {
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
			actions: []plugin.Action{&invokeAction{id: "open"}},
			contributions: []plugin.Contribution{{
				ID: "demo-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open", Label: "打开",
			}},
		}
		svc := newInvokeService(t, p, nil, nil, nil)

		_, err := svc.Invoke(ctx, "demo", "open", plugin.InvokeRequest{Surface: plugin.SurfaceEntryListToolbar})
		require.ErrorIs(t, err, service.ErrPluginSurfaceUndeclared)
	})

	t.Run("外部插件无 entries:full 只给摘要", func(t *testing.T) {
		var got plugin.InvokeRequest
		action := &invokeAction{id: "summarize", got: &got}
		p := &invokePlugin{
			meta: plugin.Meta{
				ID: "ext-ai", Name: "Ext AI", Builtin: false,
				Permissions: []string{"entries:read"},
			},
			actions: []plugin.Action{action},
			contributions: []plugin.Contribution{{
				ID: "ext-summarize", Surface: plugin.SurfaceEntryContextMenu, Action: "summarize",
				Label: "摘要", Selection: plugin.SelectionSingle,
			}},
		}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			10: {ID: 10, FeedID: 1, Title: stringPtr("标题"), Content: stringPtr("全文"), Author: stringPtr("作者")},
		}}
		svc := newInvokeService(t, p, entries, nil, nil)

		_, err := svc.Invoke(ctx, "ext-ai", "summarize", plugin.InvokeRequest{
			Surface:   plugin.SurfaceEntryContextMenu,
			Selection: plugin.Selection{EntryIDs: []int64{10}},
		})
		require.NoError(t, err)
		require.Len(t, got.Entries, 1, "有 entries:read ⇒ 摘要字段要补")
		require.Nil(t, got.Entries[0].Content, "没有 entries:full ⇒ 正文必须裁掉")
		require.NotNil(t, got.Entries[0].Title)
		require.NotNil(t, got.Entries[0].Author)
	})

	t.Run("外部插件无任何权限不补明细", func(t *testing.T) {
		var got plugin.InvokeRequest
		action := &invokeAction{id: "ping", got: &got}
		p := &invokePlugin{
			meta:    plugin.Meta{ID: "ext-bare", Name: "Ext Bare", Builtin: false},
			actions: []plugin.Action{action},
			contributions: []plugin.Contribution{{
				ID: "ext-ping", Surface: plugin.SurfaceAppCommand, Action: "ping",
				Label: "Ping", Selection: plugin.SelectionMulti,
			}},
		}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			10: {ID: 10, Title: stringPtr("标题"), Content: stringPtr("全文")},
		}}
		svc := newInvokeService(t, p, entries, nil, nil)

		_, err := svc.Invoke(ctx, "ext-bare", "ping", plugin.InvokeRequest{
			Surface:   plugin.SurfaceAppCommand,
			Selection: plugin.Selection{EntryIDs: []int64{10}},
		})
		require.NoError(t, err)
		require.Empty(t, got.Entries, "没声明 entries:read ⇒ 不许补条目明细")
		require.Equal(t, []int64{10}, got.Selection.EntryIDs, "选择本身原样保留")
	})
}
