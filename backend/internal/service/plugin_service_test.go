package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/service"
)

// settingsStub 简化版设置仓储，pluginService.GetSettings/PutSettings 需要 GetByPrefix。
type settingsStub struct {
	data map[string]model.Setting
}

func newSettingsStub() *settingsStub { return &settingsStub{data: make(map[string]model.Setting)} }
func (s *settingsStub) Get(_ context.Context, key string) (*model.Setting, error) {
	if v, ok := s.data[key]; ok {
		vv := v
		return &vv, nil
	}
	return nil, nil
}
func (s *settingsStub) Set(_ context.Context, key, value string) error {
	s.data[key] = model.Setting{Key: key, Value: value, UpdatedAt: time.Now().UTC()}
	return nil
}
func (s *settingsStub) Delete(_ context.Context, key string) error {
	delete(s.data, key)
	return nil
}
func (s *settingsStub) GetByPrefix(_ context.Context, prefix string) ([]model.Setting, error) {
	var out []model.Setting
	for _, v := range s.data {
		if len(v.Key) >= len(prefix) && v.Key[:len(prefix)] == prefix {
			out = append(out, v)
		}
	}
	return out, nil
}
func (s *settingsStub) SetMany(_ context.Context, values map[string]string) error {
	for k, v := range values {
		s.data[k] = model.Setting{Key: k, Value: v, UpdatedAt: time.Now().UTC()}
	}
	return nil
}
func (s *settingsStub) DeleteByPrefix(_ context.Context, prefix string) (int64, error) {
	var n int64
	for k := range s.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(s.data, k)
			n++
		}
	}
	return n, nil
}

// fakeAction 简化的动作实现。
type fakeAction struct {
	id      string
	label   string
	fields  []plugin.Field
	execute func(plugin.ActionRequest) error
	test    func(context.Context) error
}

func (a fakeAction) ID() string {
	if a.id != "" {
		return a.id
	}
	return "log"
}
func (a fakeAction) Label() string {
	if a.label != "" {
		return a.label
	}
	return "test action"
}
func (a fakeAction) Fields() []plugin.Field { return a.fields }
func (a fakeAction) Execute(_ context.Context, req plugin.ActionRequest) error {
	if a.execute != nil {
		return a.execute(req)
	}
	return nil
}
func (a fakeAction) Test(ctx context.Context) error {
	if a.test != nil {
		return a.test(ctx)
	}
	return nil
}

// fakePluginWithAction 构造一个带动作的 fake 插件。
type fakePluginWithAction struct {
	meta     plugin.Meta
	sections []plugin.SettingsSection
	action   plugin.Action
}

func (f fakePluginWithAction) Meta() plugin.Meta        { return f.meta }
func (f fakePluginWithAction) Actions() []plugin.Action { return []plugin.Action{f.action} }
func (f fakePluginWithAction) SettingsSections() []plugin.SettingsSection {
	if f.sections != nil {
		return f.sections
	}
	return []plugin.SettingsSection{}
}
func (f fakePluginWithAction) EntryProcessors() []plugin.EntryProcessor { return nil }
func (f fakePluginWithAction) FetchClassifiers() []plugin.FetchClassifier {
	return nil
}

// fakePluginRepo 模拟插件仓库。
type fakePluginRepo struct {
	states map[string]bool
}

func newFakePluginRepo() *fakePluginRepo { return &fakePluginRepo{states: make(map[string]bool)} }
func (r *fakePluginRepo) List(ctx context.Context) ([]repository.PluginState, error) {
	var out []repository.PluginState
	for id, enabled := range r.states {
		out = append(out, repository.PluginState{ID: id, Enabled: enabled})
	}
	return out, nil
}
func (r *fakePluginRepo) Upsert(ctx context.Context, id string, enabled bool) error {
	r.states[id] = enabled
	return nil
}
func (r *fakePluginRepo) Delete(ctx context.Context, id string) error {
	delete(r.states, id)
	return nil
}

func TestCatalog_EnsuresBuiltinRows(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	// Register a builtin-like plugin
	p := fakePluginWithAction{
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "log"},
	}
	require.NoError(t, reg.Register(p))

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	ctx := context.Background()

	// Initially empty in repo
	states, _ := fakeReg.List(ctx)
	require.Empty(t, states)

	// Catalog should ensure it's in the DB
	items, err := svc.Catalog(ctx)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "demo", items[0].ID)

	// After catalog, it's recorded in repo
	states, _ = fakeReg.List(ctx)
	require.Len(t, states, 1)
	require.True(t, states[0].Enabled)
}

func TestSetEnabled_UnknownPlugin(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	ctx := context.Background()

	_, err := svc.SetEnabled(ctx, "ghost-plugin", true)
	require.Error(t, err)
	// Check if it's the right error
	require.Contains(t, err.Error(), "plugin not found")
}

func TestPutSettings_PlainTextField(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	// Register a plugin with a plain field (not secret)
	action := fakeAction{
		id:     "notify",
		label:  "Notify",
		fields: []plugin.Field{{Key: "note", Type: "text"}}, // Plain text field
	}
	p := fakePluginWithAction{
		meta:   plugin.Meta{ID: "bark", Name: "Bark", Builtin: true},
		action: action,
	}
	require.NoError(t, reg.Register(p))

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	ctx := context.Background()

	// Set a value
	result, err := svc.PutSettings(ctx, "bark", map[string]string{"note": "hello"})
	require.NoError(t, err)
	require.Equal(t, "hello", result.Values["note"])

	// Get settings - should return same value (not masked)
	values, err := svc.GetSettings(ctx, "bark")
	require.NoError(t, err)
	require.Equal(t, "hello", values.Values["note"])
}

func TestTestAction_DisabledPlugin(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	// Disable the plugin in repo
	fakeReg.states["demo"] = false

	p := fakePluginWithAction{
		meta: plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
		action: fakeAction{id: "test", test: func(ctx context.Context) error {
			t.Fatal("disabled plugin test should not be called")
			return nil
		}},
	}
	require.NoError(t, reg.Register(p))

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	ctx := context.Background()

	err := svc.TestAction(ctx, "demo", "test")
	require.Error(t, err)
	require.Contains(t, err.Error(), "plugin disabled")
}

// TestPutSettings_MaskedSecretKeepsOldValue 掩码回传 = 用户没改：库里必须保持原值。
// 这条是安全行为——万一失效，前端会把 •••••••• 当成真值写进库，Bark 地址（带设备 key）直接报废。
func TestPutSettings_MaskedSecretKeepsOldValue(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	p := fakePluginWithAction{
		meta: plugin.Meta{ID: "bark", Name: "Bark", Builtin: true},
		action: fakeAction{
			id:     "notify",
			label:  "Notify",
			fields: []plugin.Field{{Key: "url", Type: "secret"}},
		},
	}
	require.NoError(t, reg.Register(p))

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	ctx := context.Background()

	// ① 先写真值
	_, err := svc.PutSettings(ctx, "bark", map[string]string{"url": "https://api.day.app/REALKEY"})
	require.NoError(t, err)

	// ② 读出来必须是掩码（真值不外泄到前端）
	values, err := svc.GetSettings(ctx, "bark")
	require.NoError(t, err)
	require.Equal(t, service.PluginMaskedValue, values.Values["url"])

	// ③ 前端把掩码原样回传（没改这一项）：库里必须还是真值
	_, err = svc.PutSettings(ctx, "bark", map[string]string{"url": service.PluginMaskedValue})
	require.NoError(t, err)
	got, err := settingRepo.Get(ctx, "plugin.bark.url")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, "https://api.day.app/REALKEY", got.Value, "掩码回传不许把 •••••••• 写进库")

	// ④ 换成新真值要能写进去
	_, err = svc.PutSettings(ctx, "bark", map[string]string{"url": "https://api.day.app/NEWKEY"})
	require.NoError(t, err)
	got, err = settingRepo.Get(ctx, "plugin.bark.url")
	require.NoError(t, err)
	require.Equal(t, "https://api.day.app/NEWKEY", got.Value)
}

// TestContributions_HonorsDisabledFromRepo 冷启动后（注册表只有默认值）直接读界面贡献，
// 也要按库里的启停位过滤 —— 否则停用的插件重启后菜单项会「诈尸」，
// 一直到用户点一次设置页（Catalog 装载启停位）才消失。
func TestContributions_HonorsDisabledFromRepo(t *testing.T) {
	reg := plugin.NewRegistry()
	fakeReg := newFakePluginRepo()
	settingRepo := newSettingsStub()

	p := &invokePlugin{
		meta:    plugin.Meta{ID: "barkish", Name: "Barkish", Builtin: true},
		actions: []plugin.Action{&invokeAction{id: "notify"}},
		contributions: []plugin.Contribution{{
			ID: "push", Surface: plugin.SurfaceEntryContextMenu, Action: "notify",
			Label: "推送", Selection: plugin.SelectionSingle,
		}},
	}
	require.NoError(t, reg.Register(p))
	// 库里明确停用；注册表此时还没装载过启停位（默认启用）。
	fakeReg.states["barkish"] = false

	svc := service.NewPluginService(reg, fakeReg, settingRepo)
	surfaces := svc.Contributions(context.Background())
	require.Empty(t, surfaces[plugin.SurfaceEntryContextMenu], "库里停用的插件不许出现在界面贡献里")

	// 反过来：库里启用时要有（避免上面因为别的原因空着而假绿）
	fakeReg.states["barkish"] = true
	reg2 := plugin.NewRegistry()
	require.NoError(t, reg2.Register(p))
	svc2 := service.NewPluginService(reg2, fakeReg, settingRepo)
	require.Len(t, svc2.Contributions(context.Background())[plugin.SurfaceEntryContextMenu], 1)
}
