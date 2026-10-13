package service

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
)

// 本文件专用的最小 settings 仓储桩（settings_repo_stub_test.go 在 service_test 包，内部测试够不着）。
type sceneSettingsStub struct {
	mu   sync.Mutex
	data map[string]string
}

func newSceneSettingsStub() *sceneSettingsStub {
	return &sceneSettingsStub{data: make(map[string]string)}
}

func (s *sceneSettingsStub) Get(_ context.Context, key string) (*model.Setting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	val, ok := s.data[key]
	if !ok {
		return nil, nil
	}
	return &model.Setting{Key: key, Value: val, UpdatedAt: time.Now().UTC()}, nil
}

func (s *sceneSettingsStub) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = value
	return nil
}

func (s *sceneSettingsStub) SetMany(_ context.Context, values map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range values {
		s.data[k] = v
	}
	return nil
}

func (s *sceneSettingsStub) GetByPrefix(_ context.Context, prefix string) ([]model.Setting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []model.Setting
	for k, v := range s.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, model.Setting{Key: k, Value: v, UpdatedAt: time.Now().UTC()})
		}
	}
	return out, nil
}

func (s *sceneSettingsStub) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}

func (s *sceneSettingsStub) DeleteByPrefix(_ context.Context, prefix string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for k := range s.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(s.data, k)
			n++
		}
	}
	return n, nil
}

// 50 批 1.2：分场景模型 —— getAIConfigForScene 按场景换 provider/key/model。
func TestGetAIConfigForScene_FollowByDefault(t *testing.T) {
	repo := newSceneSettingsStub()
	repo.data["ai.provider"] = "openai"
	repo.data["ai.api_key"] = "{{SECRET_eyv549m1}}"
	repo.data["ai.base_url"] = "https://main.example.com/v1"
	repo.data["ai.model"] = "main-model"
	svc := &aiService{settingsRepo: repo}

	for _, scene := range []AIScene{SceneDefault, SceneTranslate, SceneSummary, SceneAutomation} {
		cfg, err := svc.getAIConfigForScene(context.Background(), scene)
		require.NoError(t, err)
		require.Equal(t, "main-model", cfg.Model, "scene %q", scene)
		require.Equal(t, "{{SECRET_eyv549m1}}", cfg.APIKey, "scene %q", scene)
	}
}

func TestGetAIConfigForScene_ProviderOverride(t *testing.T) {
	repo := newSceneSettingsStub()
	repo.data["ai.provider"] = "openai"
	repo.data["ai.api_key"] = "{{SECRET_eyv549m1}}"
	repo.data["ai.model"] = "main-model"
	repo.data["ai.providers"] = `[{"id":"cheap","name":"Cheap","provider":"compatible","baseUrl":"https://cheap.example.com/v1","model":"cheap-model","apiKey":"sk-cheap-abcdef123456"}]`
	repo.data["ai.scene_translate"] = "provider:cheap"
	svc := &aiService{settingsRepo: repo}

	cfg, err := svc.getAIConfigForScene(context.Background(), SceneTranslate)
	require.NoError(t, err)
	require.Equal(t, "cheap-model", cfg.Model)
	require.Equal(t, "sk-cheap-abcdef123456", cfg.APIKey)
	require.Equal(t, "compatible", cfg.Provider)
	require.Equal(t, "https://cheap.example.com/v1", cfg.BaseURL)

	// 其它场景不受影响
	cfg, err = svc.getAIConfigForScene(context.Background(), SceneSummary)
	require.NoError(t, err)
	require.Equal(t, "main-model", cfg.Model)
}

func TestGetAIConfigForScene_BrokenOverrideFallsBack(t *testing.T) {
	repo := newSceneSettingsStub()
	repo.data["ai.provider"] = "openai"
	repo.data["ai.api_key"] = "{{SECRET_eyv549m1}}"
	repo.data["ai.model"] = "main-model"
	repo.data["ai.providers"] = `not-json`
	repo.data["ai.scene_translate"] = "provider:cheap"
	svc := &aiService{settingsRepo: repo}

	// 坏 JSON 当「没配」：退回跟随，别让整条翻译挂掉
	cfg, err := svc.getAIConfigForScene(context.Background(), SceneTranslate)
	require.NoError(t, err)
	require.Equal(t, "main-model", cfg.Model)
}

func TestGetAIConfigForScene_MissingProviderIDFallsBack(t *testing.T) {
	repo := newSceneSettingsStub()
	repo.data["ai.provider"] = "openai"
	repo.data["ai.api_key"] = "{{SECRET_eyv549m1}}"
	repo.data["ai.model"] = "main-model"
	repo.data["ai.providers"] = `[{"id":"cheap","name":"Cheap","provider":"compatible","model":"cheap-model"}]`
	repo.data["ai.scene_translate"] = "provider:gone"
	svc := &aiService{settingsRepo: repo}

	cfg, err := svc.getAIConfigForScene(context.Background(), SceneTranslate)
	require.NoError(t, err)
	require.Equal(t, "main-model", cfg.Model)
}

// 场景键写入：未知值拒绝；free 归一化；provider id 校验（不在清单里归空）。
func TestSetAISettings_SceneKeys(t *testing.T) {
	repo := newSceneSettingsStub()
	repo.data["ai.providers"] = `[{"id":"p1","name":"P1","provider":"compatible","model":"m1"}]`
	svc := NewSettingsService(repo, nil).(*settingsService)

	err := svc.SetAISettings(context.Background(), &AISettings{
		Provider:        "openai",
		APIKey:          "{{SECRET_eyv549m1}}",
		Model:           "main-model",
		SceneTranslate:  "provider:p1",
		SceneSummary:    "provider:gone",
		SceneAutomation: "gibberish",
	})
	require.Error(t, err, "unknown scene value must be rejected")

	err = svc.SetAISettings(context.Background(), &AISettings{
		Provider:        "openai",
		APIKey:          "{{SECRET_eyv549m1}}",
		Model:           "main-model",
		SceneTranslate:  "free",
		SceneSummary:    "provider:p1",
		SceneAutomation: "provider:gone",
	})
	require.NoError(t, err)
	require.Equal(t, "free", repo.data["ai.scene_translate"])
	require.Equal(t, "provider:p1", repo.data["ai.scene_summary"])
	require.Equal(t, "", repo.data["ai.scene_automation"])

	// free 只对翻译合法：摘要/自动化给 free 要 400（50 批接口实测带出来的缺口）
	err = svc.SetAISettings(context.Background(), &AISettings{
		Provider:       "openai",
		APIKey:         "{{SECRET_eyv549m1}}",
		Model:          "main-model",
		SceneTranslate: "provider:p1",
		SceneSummary:   "free",
	})
	require.Error(t, err, "summary scene must not accept free")
}
