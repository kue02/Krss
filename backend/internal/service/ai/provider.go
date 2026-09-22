package ai

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
)

// Provider defines the interface for AI providers.
type Provider interface {
	// Test sends a test message and returns the response.
	Test(ctx context.Context) (string, error)
	// Name returns the provider name.
	Name() string
	// SummarizeStream generates a summary using streaming.
	// Returns two channels: one for text chunks, one for errors.
	// The text channel is closed when streaming is complete.
	SummarizeStream(ctx context.Context, systemPrompt, content string) (<-chan string, <-chan error)
	// Complete generates a response without streaming.
	Complete(ctx context.Context, systemPrompt, content string) (string, error)
}

// Config holds the configuration for an AI provider.
type Config struct {
	Provider       string // openai, anthropic, compatible
	APIKey         string
	BaseURL        string // required for openai/compatible, optional for anthropic
	Model          string
	RequestOptions map[string]any // extra request JSON parameters
}

// ProviderType constants
const (
	ProviderOpenAI     = "openai"
	ProviderAnthropic  = "anthropic"
	ProviderCompatible = "compatible"
)

var (
	ErrInvalidProvider = errors.New("invalid provider")
	ErrMissingAPIKey   = errors.New("API key is required")
	ErrMissingBaseURL  = errors.New("base URL is required for openai and compatible providers")
	ErrMissingModel    = errors.New("model is required")
)

// inContainer 判断是否跑在容器里（Docker 会创建 /.dockerenv）。
func inContainer() bool {
	_, err := os.Stat("/.dockerenv")
	return err == nil
}

// normalizeBaseURL 处理「容器里的 loopback 不是宿主机」这个坑：
// 用户在 Docker 部署下填 http://127.0.0.1:8000 指的是容器自己，连不上会报连接被重置/拒绝，
// 这里自动换成 host.docker.internal（Docker Desktop 与 OrbStack 都能解析）。
// 非容器环境、或本来就不是 loopback 时原样返回。
func normalizeBaseURL(raw string) string {
	return normalizeBaseURLIn(raw, inContainer())
}

func normalizeBaseURLIn(raw string, container bool) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return trimmed
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return trimmed
	}

	switch parsed.Hostname() {
	case "localhost", "127.0.0.1", "::1", "[::1]":
	default:
		return trimmed
	}

	if !container {
		return trimmed
	}

	host := "host.docker.internal"
	if port := parsed.Port(); port != "" {
		host += ":" + port
	}
	parsed.Host = host

	return parsed.String()
}

// NewProvider creates a new AI provider based on the config.
func NewProvider(cfg Config) (Provider, error) {
	cfg.BaseURL = normalizeBaseURL(cfg.BaseURL)
	if cfg.APIKey == "" {
		return nil, ErrMissingAPIKey
	}
	if cfg.Model == "" {
		return nil, ErrMissingModel
	}

	switch cfg.Provider {
	case ProviderOpenAI:
		if cfg.BaseURL == "" {
			return nil, ErrMissingBaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.BaseURL, cfg.Model, cfg.RequestOptions)
	case ProviderAnthropic:
		return NewAnthropicProvider(cfg.APIKey, cfg.BaseURL, cfg.Model, cfg.RequestOptions)
	case ProviderCompatible:
		if cfg.BaseURL == "" {
			return nil, ErrMissingBaseURL
		}
		return NewCompatibleProvider(cfg.APIKey, cfg.BaseURL, cfg.Model, cfg.RequestOptions)
	default:
		return nil, ErrInvalidProvider
	}
}
