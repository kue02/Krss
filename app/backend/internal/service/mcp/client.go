// Package mcp 是 MCP（Model Context Protocol）协议底座 —— 16 批（入向：MCP 取到的内容当 Feed）
// 与 17 批（出向：Krss 自己当 MCP 服务器）共用的一份实现。
//
// 传输：第一版只做 streamable-http（2025-06-18 规范）：POST JSON-RPC 到端点，
// 响应可能是 application/json，也可能是 text/event-stream（SSE 包一条 data: 消息）。
// sse（旧版 HTTP+SSE 传输）第一版不做 —— 会给出明确报错，不留半成品。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// ProtocolVersion 我们声明支持的协议版本（与方案文档一致）。
const ProtocolVersion = "2025-06-18"

// ClientInfo 客户端自报家门（规范要求 initialize 时带上）。
type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ServerIdentity 服务器自报家门（initialize 结果里的 serverInfo 字段）。
type ServerIdentity struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version"`
}

// ServerInfo initialize 的结果：协议版本 + 能力 + serverInfo。
// 注意 serverInfo 是**嵌套**的（规范形状），别按顶层字段解。
type ServerInfo struct {
	ProtocolVersion string          `json:"protocolVersion"`
	ServerInfo      ServerIdentity  `json:"serverInfo"`
	Instructions    string          `json:"instructions,omitempty"`
	Capabilities    json.RawMessage `json:"capabilities,omitempty"`
}

// Name / Version 便捷取值（调用方大多只关心这两个）。
func (s ServerInfo) Name() string    { return s.ServerInfo.Name }
func (s ServerInfo) Title() string   { return s.ServerInfo.Title }

// Tool tools/list 里的一条工具定义。
// OutputSchema 是可选的（很多自建 MCP 不声明）—— 有它就能「零人工」生成映射。
type Tool struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema,omitempty"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	Annotations  json.RawMessage `json:"annotations,omitempty"`
}

// Resource resources/list 里的一条资源。
type Resource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// Content tools/call 结果里的一段内容（规范里的联合类型，只取我们用得到的字段）。
type Content struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	Data     string    `json:"data,omitempty"`
	MimeType string    `json:"mimeType,omitempty"`
	// resource_link
	URI  string `json:"uri,omitempty"`
	Name string `json:"name,omitempty"`
	// resource（内嵌资源）
	Resource *Resource `json:"resource,omitempty"`
}

// CallToolResult tools/call 的结果：content[]（规范要求结构化内容同时给一份 text 以兼容旧客户端）
// + 可选的 structuredContent（与 outputSchema 配对）。
type CallToolResult struct {
	Content           []Content       `json:"content"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError,omitempty"`
}

// ReadResourceResult resources/read 的结果。
type ReadResourceResult struct {
	Contents []ResourceContent `json:"contents"`
}

// ResourceContent 一段资源内容。
type ResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	// Blob 是 base64（二进制）；第一版不解析，只记「有二进制但没法变成条目」。
	Blob string `json:"blob,omitempty"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int   `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message)
}

// HTTPError 传输层失败（带状态码，便于界面显示「HTTP 401」这类明确原因）。
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	body := strings.TrimSpace(e.Body)
	if len(body) > 300 {
		body = body[:300]
	}
	if body == "" {
		return fmt.Sprintf("HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("HTTP %d: %s", e.StatusCode, body)
}

// Client 一个 MCP 会话（对应一条 mcp_servers 记录）。
// 出网走调用方传进来的 http.Client —— 必须是 network.ClientFactory 建的（继承代理与非全局超时），
// 绝不在里面自己 http.Get。
type Client struct {
	httpClient *http.Client
	endpoint   string
	headers    map[string]string
	transport  string

	sse *sseSession

	mu         sync.Mutex
	nextID     int
	sessionID  string
	serverInfo ServerInfo
	ready      bool
}

// NewClient 建一个会话（默认 streamable-http）。headers 是 Header 认证的那份
// （敏感：调用方负责不把它写进日志）。
func NewClient(httpClient *http.Client, endpoint string, headers map[string]string) *Client {
	return NewClientWithTransport(httpClient, endpoint, headers, "streamable-http")
}

// NewClientWithTransport 指定传输建会话（sse = 旧版 HTTP+SSE 传输 —— 16-10）。
func NewClientWithTransport(httpClient *http.Client, endpoint string, headers map[string]string, transport string) *Client {
	client := &Client{httpClient: httpClient, endpoint: endpoint, headers: headers, transport: transport}
	if transport == "sse" {
		client.sse = newSSESession(httpClient, endpoint, headers)
	}
	return client
}

// Transport 当前用的传输（探测成功后调用方回写 last_transport 用）。
func (c *Client) Transport() string {
	if c.transport == "" {
		return "streamable-http"
	}
	return c.transport
}

// Close 关 SSE 流（streamable-http 无状态，不用管）。service 层 defer 调。
func (c *Client) Close() {
	if c.sse != nil {
		c.sse.Close()
	}
}

// ServerInfo 最近一次 initialize 的结果（用于「测试连通性」回显服务名与版本）。
func (c *Client) ServerInfo() ServerInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.serverInfo
}

// Initialize 握手：initialize + notifications/initialized。
func (c *Client) Initialize(ctx context.Context) (ServerInfo, error) {
	params := map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      ClientInfo{Name: "krss", Version: "1.0"},
	}
	raw, err := c.call(ctx, "initialize", params, true)
	if err != nil {
		return ServerInfo{}, err
	}
	var info ServerInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return ServerInfo{}, fmt.Errorf("解析 initialize 结果失败: %w", err)
	}
	c.mu.Lock()
	c.serverInfo = info
	c.ready = true
	c.mu.Unlock()

	// 规范：客户端收到 initialize 结果后必须发一条 notifications/initialized。
	if err := c.notify(ctx, "notifications/initialized", nil); err != nil {
		return info, err
	}
	return info, nil
}

// ListTools 拉工具清单。
func (c *Client) ListTools(ctx context.Context) ([]Tool, error) {
	raw, err := c.call(ctx, "tools/list", map[string]any{}, true)
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析 tools/list 结果失败: %w", err)
	}
	return out.Tools, nil
}

// CallTool 调一个工具。
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (CallToolResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, true)
	if err != nil {
		return CallToolResult{}, err
	}
	var out CallToolResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return CallToolResult{}, fmt.Errorf("解析 tools/call 结果失败: %w", err)
	}
	if out.IsError {
		return out, fmt.Errorf("MCP 工具返回 isError：%s", firstText(out.Content))
	}
	return out, nil
}

// ListResources 拉资源清单。
func (c *Client) ListResources(ctx context.Context) ([]Resource, error) {
	raw, err := c.call(ctx, "resources/list", map[string]any{}, true)
	if err != nil {
		return nil, err
	}
	var out struct {
		Resources []Resource `json:"resources"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析 resources/list 结果失败: %w", err)
	}
	return out.Resources, nil
}

// ReadResource 读一个资源。
func (c *Client) ReadResource(ctx context.Context, uri string) (ReadResourceResult, error) {
	raw, err := c.call(ctx, "resources/read", map[string]any{"uri": uri}, true)
	if err != nil {
		return ReadResourceResult{}, err
	}
	var out ReadResourceResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return ReadResourceResult{}, fmt.Errorf("解析 resources/read 结果失败: %w", err)
	}
	return out, nil
}

// firstText 取第一段文本内容（报错信息用）。
func firstText(contents []Content) string {
	for _, item := range contents {
		if item.Text != "" {
			return item.Text
		}
	}
	return ""
}

func (c *Client) nextRequestID() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return c.nextID
}

// notify 发一条通知（无 id、不期待响应）。
func (c *Client) notify(ctx context.Context, method string, params any) error {
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: method, Params: params})
	if err != nil {
		return err
	}
	if c.sse != nil {
		return c.sse.notify(ctx, body)
	}
	_, err = c.post(ctx, body)
	return err
}

// call 发一次请求并取回 result。ensureInit=true 时若还没握手就先握手（内部调用一次 Initialize）。
func (c *Client) call(ctx context.Context, method string, params any, ensureInit bool) (json.RawMessage, error) {
	if ensureInit {
		c.mu.Lock()
		ready := c.ready
		c.mu.Unlock()
		if !ready && method != "initialize" {
			if _, err := c.Initialize(ctx); err != nil {
				return nil, err
			}
		}
	}
	id := c.nextRequestID()
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: &id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	if c.sse != nil {
		return c.sse.call(ctx, id, body)
	}
	respBody, err := c.post(ctx, body)
	if err != nil {
		return nil, err
	}
	resp, err := decodeRPCResponse(respBody, id)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// post 发一次 POST 并读回响应体（可能是 JSON，也可能是 SSE）。
func (c *Client) post(ctx context.Context, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// 规范要求客户端同时接受这两种（服务器可任选一种返回）
	req.Header.Set("Accept", "application/json, text/event-stream")
	for key, value := range c.headers {
		if strings.TrimSpace(key) == "" {
			continue
		}
		req.Header.Set(key, value)
	}
	c.mu.Lock()
	session := c.sessionID
	c.mu.Unlock()
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if sid := strings.TrimSpace(resp.Header.Get("Mcp-Session-Id")); sid != "" {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}

	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	if readErr != nil {
		return nil, readErr
	}
	return raw, nil
}

// decodeRPCResponse 从响应体里取出 JSON-RPC 响应：先按 JSON 解，解不出就按 SSE 逐行找 data:。
func decodeRPCResponse(raw []byte, wantID int) (*rpcResponse, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("MCP 服务返回空响应体")
	}
	if trimmed[0] == '{' {
		var resp rpcResponse
		if err := json.Unmarshal(trimmed, &resp); err != nil {
			return nil, fmt.Errorf("解析 MCP 响应失败: %w", err)
		}
		return &resp, nil
	}

	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	var fallback *rpcResponse
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var resp rpcResponse
		if err := json.Unmarshal([]byte(payload), &resp); err != nil {
			continue
		}
		if resp.ID != nil && *resp.ID == wantID {
			return &resp, nil
		}
		if fallback == nil && (resp.Result != nil || resp.Error != nil) {
			copied := resp
			fallback = &copied
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取 MCP 事件流失败: %w", err)
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, fmt.Errorf("MCP 响应里没有找到 JSON-RPC 结果（既不是 JSON 也不是 SSE 事件）")
}
