package mcp

// OAuth 授权（16-11）：按 MCP 规范 2025-06-18 的 OAuth 2.1 + PRM 流程。
//
// ① 读 {mcpURL}/.well-known/oauth-protected-resource → 拿 authorization_servers
// ② 读 {as}/.well-known/oauth-authorization-server → 拿 authorize/token/register 端点
// ③ 动态注册客户端 DCR（拿不到就让用户手填 client_id/client_secret —— 不支持 DCR 的服务）
// ④ PKCE 浏览器授权（S256）
// ⑤ 回调换 token → 进库、掩码回显、自动刷新、不进日志
//
// 回调地址运行时取当前访问 origin（<origin>/api/mcp/oauth/callback），零配置、远程可用。
// 本文件只做协议（纯函数 + http，出错原样返回）；落库与 state 管理在 service 层。

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrDCRUnsupported 该服务不支持动态注册 → 界面退回手填 client_id/secret。
var ErrDCRUnsupported = fmt.Errorf("该服务不支持自动注册（DCR）")

// AuthServerMetadata authorization-server 元数据（我们只取用得到的四个端点）。
type AuthServerMetadata struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	RegistrationEndpoint  string `json:"registration_endpoint,omitempty"`
}

// OAuthTokens 换回来的 token 一套（进库；出接口掩码；不进日志）。
type OAuthTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    *time.Time
	TokenType    string
	Scope        string
}

// DiscoverAuthServer 按 PRM 流程找授权服务器：先问 MCP 服务自己（well-known/prm），
// 404 就退回「MCP 地址 origin 上的 authorization-server 元数据」（很多自建服务只配后者）。
func DiscoverAuthServer(ctx context.Context, httpClient *http.Client, mcpURL string) (authServer string, meta AuthServerMetadata, err error) {
	base := strings.TrimRight(strings.TrimSpace(mcpURL), "/")
	if base == "" {
		return "", AuthServerMetadata{}, fmt.Errorf("MCP 地址为空")
	}
	// ① PRM：{mcpURL}/.well-known/oauth-protected-resource
	var prm struct {
		AuthorizationServers []string `json:"authorization_servers"`
	}
	if fetchErr := fetchJSON(ctx, httpClient, base+"/.well-known/oauth-protected-resource", nil, &prm); fetchErr == nil && len(prm.AuthorizationServers) > 0 {
		authServer = strings.TrimRight(prm.AuthorizationServers[0], "/")
		if meta, err = fetchAuthServerMetadata(ctx, httpClient, authServer); err == nil {
			return authServer, meta, nil
		}
	}
	// ② 退回 origin：{origin}/.well-known/oauth-authorization-server
	parsed, parseErr := url.Parse(base)
	if parseErr != nil || parsed.Host == "" {
		return "", AuthServerMetadata{}, fmt.Errorf("MCP 地址解析失败")
	}
	origin := parsed.Scheme + "://" + parsed.Host
	if meta, err = fetchAuthServerMetadata(ctx, httpClient, origin); err == nil {
		return origin, meta, nil
	}
	return "", AuthServerMetadata{}, fmt.Errorf("没找到授权服务器（PRM 与 authorization-server 元数据都读不到）: %w", err)
}

func fetchAuthServerMetadata(ctx context.Context, httpClient *http.Client, issuer string) (AuthServerMetadata, error) {
	var meta AuthServerMetadata
	endpoint := strings.TrimRight(issuer, "/") + "/.well-known/oauth-authorization-server"
	if err := fetchJSON(ctx, httpClient, endpoint, nil, &meta); err != nil {
		return AuthServerMetadata{}, err
	}
	if meta.AuthorizationEndpoint == "" || meta.TokenEndpoint == "" {
		return AuthServerMetadata{}, fmt.Errorf("授权服务器元数据缺 authorize/token 端点")
	}
	if meta.Issuer == "" {
		meta.Issuer = strings.TrimRight(issuer, "/")
	}
	return meta, nil
}

// RegisterClient DCR：在授权服务器上动态注册一个公开客户端（PKCE，无 secret）。
// 注册端点缺失或服务器拒绝 → ErrDCRUnsupported（界面给手填框，不报错）。
func RegisterClient(ctx context.Context, httpClient *http.Client, meta AuthServerMetadata, redirectURI, clientName string) (clientID, clientSecret string, err error) {
	if strings.TrimSpace(meta.RegistrationEndpoint) == "" {
		return "", "", ErrDCRUnsupported
	}
	body, _ := json.Marshal(map[string]any{
		"client_name":               clientName,
		"redirect_uris":             []string{redirectURI},
		"grant_types":               []string{"authorization_code", "refresh_token"},
		"response_types":            []string{"code"},
		"token_endpoint_auth_method": "none",
		"scope":                     "mcp",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, meta.RegistrationEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
		return "", "", ErrDCRUnsupported
	}
	if resp.StatusCode >= http.StatusBadRequest {
		// 400 也可能是「不支持 DCR」的一种表现 —— 文案里带上原文，方便定位
		if resp.StatusCode == http.StatusBadRequest {
			return "", "", fmt.Errorf("%w：%s", ErrDCRUnsupported, truncateHTTPBody(string(raw)))
		}
		return "", "", &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	var out struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.ClientID == "" {
		return "", "", fmt.Errorf("%w：注册响应里没有 client_id", ErrDCRUnsupported)
	}
	return out.ClientID, out.ClientSecret, nil
}

// NewState 生成 state（callback 的凭证，256 位随机）。
func NewState() (string, error) {
	return randomURLSafe(32)
}

// NewVerifier 生成 PKCE verifier（S256 要求 43~128 字符，这里用 64 字节 → 86 字符）。
func NewVerifier() (string, error) {
	return randomURLSafe(64)
}

// Challenge 由 verifier 算 S256 challenge。
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// BuildAuthorizeURL 拼浏览器授权地址（resource 参数按 RFC 8707 带上 MCP 地址 ——
// 要求授权服务器「给这个资源」发 token 的服务认这个）。
func BuildAuthorizeURL(meta AuthServerMetadata, clientID, redirectURI, scope, resource, verifier, state string) string {
	query := url.Values{}
	query.Set("response_type", "code")
	query.Set("client_id", clientID)
	query.Set("redirect_uri", redirectURI)
	if scope != "" {
		query.Set("scope", scope)
	}
	if resource != "" {
		query.Set("resource", resource)
	}
	query.Set("code_challenge", Challenge(verifier))
	query.Set("code_challenge_method", "S256")
	query.Set("state", state)
	return meta.AuthorizationEndpoint + "?" + query.Encode()
}

// ExchangeCode 回调换 token（authorization_code → access/refresh）。
func ExchangeCode(ctx context.Context, httpClient *http.Client, tokenEndpoint, clientID, clientSecret, code, redirectURI, verifier string) (OAuthTokens, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("client_id", clientID)
	form.Set("code_verifier", verifier)
	return postToken(ctx, httpClient, tokenEndpoint, clientID, clientSecret, form)
}

// RefreshTokens 自动刷新（refresh_token → 新 access；有的服务连 refresh 一起换）。
func RefreshTokens(ctx context.Context, httpClient *http.Client, tokenEndpoint, clientID, clientSecret, refreshToken string) (OAuthTokens, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	form.Set("client_id", clientID)
	return postToken(ctx, httpClient, tokenEndpoint, clientID, clientSecret, form)
}

func postToken(ctx context.Context, httpClient *http.Client, tokenEndpoint, clientID, clientSecret string, form url.Values) (OAuthTokens, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return OAuthTokens{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// 机密客户端走 Basic（RFC 6749）；公开客户端（无 secret）只靠表单里的 client_id + PKCE。
	if clientSecret != "" {
		req.SetBasicAuth(url.QueryEscape(clientID), url.QueryEscape(clientSecret))
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return OAuthTokens{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= http.StatusBadRequest {
		return OAuthTokens{}, &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return OAuthTokens{}, fmt.Errorf("token 响应解析失败: %w", err)
	}
	if out.AccessToken == "" {
		desc := out.ErrorDesc
		if desc == "" {
			desc = truncateHTTPBody(string(raw))
		}
		return OAuthTokens{}, fmt.Errorf("换 token 失败（%s）：%s", oauthFirstNonEmpty(out.Error, "unknown"), desc)
	}
	tokens := OAuthTokens{
		AccessToken:  out.AccessToken,
		RefreshToken: out.RefreshToken,
		TokenType:    oauthFirstNonEmpty(out.TokenType, "Bearer"),
		Scope:        out.Scope,
	}
	if out.ExpiresIn > 0 {
		at := time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
		tokens.ExpiresAt = &at
	}
	return tokens, nil
}

// fetchJSON 读一个公开 JSON（发现/DCR 用；不带任何认证头）。
func fetchJSON(ctx context.Context, httpClient *http.Client, endpoint string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		if strings.TrimSpace(key) == "" {
			continue
		}
		req.Header.Set(key, value)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= http.StatusBadRequest {
		return &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("解析 %s 失败: %w", endpoint, err)
	}
	return nil
}

func randomURLSafe(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func truncateHTTPBody(s string) string {
	trimmed := strings.TrimSpace(s)
	if len(trimmed) > 300 {
		trimmed = trimmed[:300] + "…"
	}
	return trimmed
}

func oauthFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
