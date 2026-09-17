package service

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"gist/backend/internal/model"
)

// webhook 动作的投递细节：出网、异步、幂等性交给下游自己判断。
//
// 与「静音 / 已读」这类只改自己库的动作不同，webhook 属于「要出网」的动作，所以：
//   - 走项目统一的网络层（继承代理设置），超时 filterWebhookTimeout
//   - 在后台 goroutine 里发（context.WithoutCancel，不让响应结束把它掐掉）
//   - 失败不重试，但把原因写进规则的 last_error（规则表上直接看得到）
const filterWebhookTimeout = 10 * time.Second

// FilterWebhookPayload 投递出去的报文（字段名是稳定契约，改了会打到用户的下游）。
type FilterWebhookPayload struct {
	Event     string              `json:"event"`
	Filter    FilterWebhookRule   `json:"filter"`
	Entry     FilterWebhookEntry  `json:"entry"`
	Actions   model.FilterActions `json:"actions"`
	MatchedAt string              `json:"matchedAt"`
}

// FilterWebhookRule 规则本体（够下游认出是哪条规则就行，不搬运整条规则）。
type FilterWebhookRule struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ScopeType string `json:"scopeType"`
	ScopeID   string `json:"scopeId,omitempty"`
}

// FilterWebhookEntry 命中的条目。
type FilterWebhookEntry struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Author      string `json:"author,omitempty"`
	FeedID      string `json:"feedId"`
	FeedTitle   string `json:"feedTitle"`
	PublishedAt string `json:"publishedAt,omitempty"`
}

// FilterWebhookSender 把报文投递到 URL，返回 HTTP 状态码。
// 抽成接口是为了能在测试里用假实现（不真出网），以及让 service 层不依赖网络层具体实现。
type FilterWebhookSender interface {
	Send(ctx context.Context, url string, payload []byte) (int, error)
}

type httpWebhookSender struct {
	client *http.Client
	// userAgent 让下游日志能分辨这条请求来自 webhook 还是推送（默认 webhook）
	userAgent string
}

// NewHTTPWebhookSender 用给定的 http.Client（main 里由 network.ClientFactory 造，因而会走代理设置）。
func NewHTTPWebhookSender(client *http.Client) FilterWebhookSender {
	return &httpWebhookSender{client: client, userAgent: "gist-filter-webhook/1"}
}

func (s *httpWebhookSender) Send(ctx context.Context, url string, payload []byte) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", s.userAgent)

	response, err := s.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer func() { _ = response.Body.Close() }()
	// 读掉一小段 body：一是让连接能复用，二是失败时把下游的话带回来当原因
	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))

	if response.StatusCode >= http.StatusBadRequest {
		snippet := string(bytes.TrimSpace(body))
		if snippet != "" {
			return response.StatusCode, fmt.Errorf("HTTP %d: %s", response.StatusCode, truncateRunes(snippet, 120))
		}
		return response.StatusCode, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return response.StatusCode, nil
}
