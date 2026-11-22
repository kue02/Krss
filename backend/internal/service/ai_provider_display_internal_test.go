package service

import (
	"context"
	"encoding/json"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/service/ai"
)

// mapSettingsRepo 是 settings repository 的最小内存实现，够 getAIConfigForScene 用。
type mapSettingsRepo struct{ data map[string]string }

func (m *mapSettingsRepo) Get(_ context.Context, key string) (*model.Setting, error) {
	if v, ok := m.data[key]; ok {
		return &model.Setting{Key: key, Value: v}, nil
	}
	return nil, nil
}
func (m *mapSettingsRepo) Set(_ context.Context, key, value string) error {
	m.data[key] = value
	return nil
}
func (m *mapSettingsRepo) SetMany(_ context.Context, values map[string]string) error {
	for k, v := range values {
		m.data[k] = v
	}
	return nil
}
func (m *mapSettingsRepo) GetByPrefix(_ context.Context, prefix string) ([]model.Setting, error) {
	out := make([]model.Setting, 0, len(m.data))
	for k, v := range m.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, model.Setting{Key: k, Value: v})
		}
	}
	return out, nil
}
func (m *mapSettingsRepo) Delete(_ context.Context, key string) error {
	delete(m.data, key)
	return nil
}
func (m *mapSettingsRepo) DeleteByPrefix(_ context.Context, prefix string) (int64, error) {
	var n int64
	for k := range m.data {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(m.data, k)
			n++
		}
	}
	return n, nil
}

// 用户给提供商卡起的名字要作为「提供商」展示，而不是协议常量 compatible。
func TestGetAIConfigForScene_UsesProviderDisplayName(t *testing.T) {
	providers, _ := json.Marshal([]AIProviderConfig{
		{ID: "p1", Name: "DeepSeek", Provider: "compatible", BaseURL: "https://api.deepseek.com", Model: "deepseek-chat", APIKey: "k"},
	})
	repo := &mapSettingsRepo{data: map[string]string{
		"ai.provider":           "compatible",
		"ai.api_key":            "k",
		"ai.model":              "deepseek-chat",
		"ai.active_provider_id": "p1",
		"ai.providers":          string(providers),
	}}
	svc := NewAIService(nil, nil, nil, repo, ai.NewRateLimiter(10)).(*aiService)

	cfg, err := svc.getAIConfigForScene(context.Background(), SceneTranslate)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Provider != ai.ProviderCompatible {
		t.Fatalf("adapter provider must stay compatible, got %q", cfg.Provider)
	}
	if cfg.ProviderName != "DeepSeek" {
		t.Fatalf("ProviderName = %q, want DeepSeek", cfg.ProviderName)
	}
	if got := providerDisplayName(cfg); got != "DeepSeek" {
		t.Fatalf("providerDisplayName = %q, want DeepSeek", got)
	}
}

func TestProviderDisplayName_FallsBackToProtocol(t *testing.T) {
	if got := providerDisplayName(ai.Config{Provider: ai.ProviderOpenAI}); got != "openai" {
		t.Fatalf("providerDisplayName = %q, want openai", got)
	}
}
