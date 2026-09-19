package mcp

// SSE 旧传输（2024-11-05 那套 HTTP+SSE，16-10 客户端侧）。
//
// 流程：GET 端点建一条 text/event-stream 长连接 → 服务器先回 `event: endpoint`
// （data 里是收消息的 POST 地址，带 sessionId）→ 之后的 JSON-RPC 全 POST 到那个地址
// （回 202），真正的响应以 `event: message` 从 GET 那条流里回来，按 JSON-RPC id 对上号。
//
// 注意 streamable-http 的客户端已经能解「POST 响应体里的 SSE」（decodeRPCResponse），
// 所以很多自称 SSE 的服务其实不用到这里 —— 只有 POST 打过去返回 404/405/非 MCP 内容时，
// 才降级到这个真正的旧传输（见 service 层的传输探测顺序）。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

type sseResult struct {
	raw json.RawMessage
	err error
}

// sseSession 一次 SSE 会话（对应一条 mcp_servers 记录的一次操作）。
// 短命：调完就 Close（关流、停读协程），不在操作之间复用。
type sseSession struct {
	httpClient *http.Client
	sseURL     string
	headers    map[string]string

	mu         sync.Mutex
	endpoint   string // 解析好的 POST 地址（空 = 流断了，下次调用重建）
	cancel     context.CancelFunc
	streamBody io.ReadCloser // GET 长连接的 body（Close 时关掉，否则两边死等）
	pending    map[int]chan sseResult
}

func newSSESession(httpClient *http.Client, sseURL string, headers map[string]string) *sseSession {
	return &sseSession{httpClient: httpClient, sseURL: sseURL, headers: headers, pending: map[int]chan sseResult{}}
}

// Close 关流并叫停读协程。Client 用完必须调（service 层 defer）。
func (s *sseSession) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	// 先关 body：读协程可能正堵在 Scan 里，只停 ctx 叫不醒它；
	// 关了 body 服务器那头也会收到连接断开（httptest.Close 才退得出来）。
	if s.streamBody != nil {
		s.streamBody.Close()
		s.streamBody = nil
	}
	s.endpoint = ""
	for id, ch := range s.pending {
		close(ch)
		delete(s.pending, id)
	}
}

// call 发一次 JSON-RPC 并等流里的响应（按 id 对号）。
func (s *sseSession) call(ctx context.Context, id int, body []byte) (json.RawMessage, error) {
	endpoint, err := s.ensure(ctx)
	if err != nil {
		return nil, err
	}

	reply := make(chan sseResult, 1)
	s.mu.Lock()
	s.pending[id] = reply
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	// POST 发出去：旧规范回 202（响应走流）；个别不规范的实现直接 200 带 body，也兼容。
	direct, postErr := s.postMessage(ctx, endpoint, body)
	if postErr != nil {
		return nil, postErr
	}
	if len(direct) > 0 {
		if resp, err := decodeRPCResponse(direct, id); err == nil {
			if resp.Error != nil {
				return nil, resp.Error
			}
			return resp.Result, nil
		}
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result, ok := <-reply:
		if !ok {
			return nil, fmt.Errorf("SSE 流已断开")
		}
		if result.err != nil {
			return nil, result.err
		}
		resp, err := decodeRPCResponse(result.raw, id)
		if err != nil {
			return nil, err
		}
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	}
}

// notify 发一条通知（不期待响应）。
func (s *sseSession) notify(ctx context.Context, body []byte) error {
	endpoint, err := s.ensure(ctx)
	if err != nil {
		return err
	}
	_, err = s.postMessage(ctx, endpoint, body)
	return err
}

// ensure 流可用（已有就复用，断了就重建并等 endpoint 事件）。
func (s *sseSession) ensure(ctx context.Context) (string, error) {
	s.mu.Lock()
	endpoint := s.endpoint
	s.mu.Unlock()
	if endpoint != "" {
		return endpoint, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.sseURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "text/event-stream")
	applyHeaders(req, s.headers)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	// 先判状态：非 2xx 直接关流读 body 报错（Classify 按 HTTPError 分桶）。
	if resp.StatusCode >= http.StatusBadRequest {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		return "", &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}

	// 等第一个 endpoint 事件（带上 ctx 超时，别无限等）。
	endpointURL, err := waitEndpointEvent(ctx, resp.Body, s.sseURL)
	if err != nil {
		resp.Body.Close()
		return "", err
	}

	streamCtx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	// 同一个 Client 实例里 ensure 可能调多次（重建）：旧 body 先关，免得泄漏
	if s.streamBody != nil {
		s.streamBody.Close()
	}
	s.streamBody = resp.Body
	s.endpoint = endpointURL
	s.cancel = cancel
	s.mu.Unlock()
	go s.readLoop(streamCtx, resp.Body)
	return endpointURL, nil
}

// waitEndpointEvent 从流里读到 `event: endpoint`，把 data 解析成绝对 POST 地址。
func waitEndpointEvent(ctx context.Context, body io.Reader, base string) (string, error) {
	type eventResult struct {
		url string
		err error
	}
	ch := make(chan eventResult, 1)
	go func() {
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
		var eventName string
		var dataLines []string
		flush := func() (string, string) {
			name, data := eventName, strings.Join(dataLines, "\n")
			eventName, dataLines = "", nil
			return name, data
		}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				name, data := flush()
				if name == "endpoint" && strings.TrimSpace(data) != "" {
					ch <- eventResult{url: resolveURL(base, strings.TrimSpace(data))}
					return
				}
				continue
			}
			if strings.HasPrefix(line, "event:") {
				eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			} else if strings.HasPrefix(line, "data:") {
				dataLines = append(dataLines, strings.TrimPrefix(line, "data:"))
			}
		}
		if err := scanner.Err(); err != nil {
			ch <- eventResult{err: fmt.Errorf("读 SSE endpoint 事件失败: %w", err)}
			return
		}
		ch <- eventResult{err: fmt.Errorf("SSE 流里没有 endpoint 事件（对方可能不是 SSE 传输）")}
	}()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case result := <-ch:
		return result.url, result.err
	}
}

// readLoop 常驻读流：message 事件按 id 分给等着的调用；流断了就清 endpoint 让下次重建。
func (s *sseSession) readLoop(ctx context.Context, body io.ReadCloser) {
	defer body.Close()
	defer func() {
		s.mu.Lock()
		s.endpoint = ""
		for id, ch := range s.pending {
			close(ch)
			delete(s.pending, id)
		}
		s.mu.Unlock()
	}()

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	var dataLines []string
	dispatch := func() {
		data := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = nil
		if data == "" || data == "[DONE]" {
			return
		}
		var probe struct {
			ID *int `json:"id"`
		}
		if err := json.Unmarshal([]byte(data), &probe); err != nil || probe.ID == nil {
			return
		}
		s.mu.Lock()
		ch, ok := s.pending[*probe.ID]
		s.mu.Unlock()
		if ok {
			select {
			case ch <- sseResult{raw: json.RawMessage(data)}:
			case <-ctx.Done():
			}
		}
	}
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Text()
		if line == "" {
			dispatch()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(line, "data:"))
		}
		// event: 行不关心 —— message 与 endpoint 都按 data 内容处理
	}
}

func (s *sseSession) postMessage(ctx context.Context, endpoint string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	applyHeaders(req, s.headers)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode == http.StatusAccepted || len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil // 202 或空体：响应走流里等
	}
	return raw, nil
}

func applyHeaders(req *http.Request, headers map[string]string) {
	for key, value := range headers {
		if strings.TrimSpace(key) == "" {
			continue
		}
		req.Header.Set(key, value)
	}
}

func resolveURL(base, ref string) string {
	parsed, err := url.Parse(strings.TrimSpace(ref))
	if err != nil {
		return strings.TrimSpace(ref)
	}
	if parsed.IsAbs() {
		return parsed.String()
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return strings.TrimSpace(ref)
	}
	return baseURL.ResolveReference(parsed).String()
}
