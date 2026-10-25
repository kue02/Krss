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

func (a fakeAction) ID() string                              { if a.id != "" { return a.id }; return "log" }
func (a fakeAction) Label() string                           { if a.label != "" { return a.label }; return "test action" }
func (a fakeAction) Fields() []plugin.Field                  { return a.fields }
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

func (f fakePluginWithAction) Meta() plugin.Meta                       { return f.meta }
func (f fakePluginWithAction) Actions() []plugin.Action                { return []plugin.Action{f.action} }
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

func newFakePluginRepo() *fakePluginRepo         { return &fakePluginRepo{states: make(map[string]bool)} }
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
		id:   "notify",
		label: "Notify",
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
		meta:   plugin.Meta{ID: "demo", Name: "Demo", Builtin: true},
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
