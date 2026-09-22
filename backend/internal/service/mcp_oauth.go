package service

// MCP OAuth 授权的 service 层（16-11）：发现 → DCR → PKCE → 回调换 token → 自动刷新。
//
// 约定：
//   - token 进库（mcp_servers.oauth_*，迁移 28），出接口一律掩码，日志里绝不出现值
//     （记日志只带 mcp_server_id 与 host，见既有口径）。
//   - 回调地址运行时取当前访问 origin（前端把 window.location.origin + 后缀传进来当
//     redirect_uri），后端不拼、不存、不写死 localhost —— 零配置、远程可用。
//   - state → verifier 的映射放内存（10 分钟过期，单次有效）；机器重启会丢，
//     丢了用户重新点一次授权即可（回调会明确报「授权已过期，请重新发起」）。

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/service/mcp"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

// OAuthPending 一次进行中的授权（state 当凭证）。
type oauthPending struct {
	serverID      int64
	verifier      string
	clientID      string
	clientSecret  string
	redirectURI   string
	authServer    string
	tokenEndpoint string
	scope         string
	expires       time.Time
}

var oauthPendings = struct {
	sync.Mutex
	items map[string]oauthPending
}{items: map[string]oauthPending{}}

// OAuthDiscoveryResult 发现结果（界面决定显示「授权」还是「手填 client_id/secret」）。
type OAuthDiscoveryResult struct {
	AuthServer   string `json:"authServer"`
	HasDCR       bool   `json:"hasDCR"`
	NeedsManual  bool   `json:"needsManual"`
	HasClientID  bool   `json:"hasClientID"`
	Instructions string `json:"instructions,omitempty"`
}

// OAuthStartResult 开始授权：前端拿 authURL 开浏览器。
type OAuthStartResult struct {
	AuthURL string `json:"authURL"`
	State   string `json:"state"`
}

func storeOAuthPending(state string, pending oauthPending) {
	oauthPendings.Lock()
	defer oauthPendings.Unlock()
	now := time.Now()
	for key, item := range oauthPendings.items {
		if now.After(item.expires) {
			delete(oauthPendings.items, key)
		}
	}
	oauthPendings.items[state] = pending
}

func takeOAuthPending(state string) (oauthPending, bool) {
	oauthPendings.Lock()
	defer oauthPendings.Unlock()
	pending, ok := oauthPendings.items[state]
	if ok {
		delete(oauthPendings.items, state)
	}
	if !ok || time.Now().After(pending.expires) {
		return oauthPending{}, false
	}
	return pending, true
}

// oauthHTTPClient 发现/DCR/换 token 用的出网客户端（走统一网络层：继承代理与超时）。
func (s *mcpService) oauthHTTPClient(ctx context.Context, server model.MCPServer) *http.Client {
	return s.clientFactory.NewHTTPClient(ctx, s.timeoutFor(ctx, server))
}

// OAuthDiscovery 找授权服务器（不写库，纯读）。
func (s *mcpService) OAuthDiscovery(ctx context.Context, id int64) (OAuthDiscoveryResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return OAuthDiscoveryResult{}, ErrMCPNotFound
		}
		return OAuthDiscoveryResult{}, err
	}
	result := OAuthDiscoveryResult{}
	authServer, meta, err := mcp.DiscoverAuthServer(ctx, s.oauthHTTPClient(ctx, server), server.URL)
	if err != nil {
		result.NeedsManual = true
		result.Instructions = "没能自动发现授权服务器（" + err.Error() + "）—— 请手填 client_id / client_secret 后再授权"
		result.HasClientID = strings.TrimSpace(server.OAuthClientID) != ""
		return result, nil
	}
	result.AuthServer = authServer
	result.HasDCR = strings.TrimSpace(meta.RegistrationEndpoint) != ""
	result.NeedsManual = !result.HasDCR && strings.TrimSpace(server.OAuthClientID) == ""
	result.HasClientID = strings.TrimSpace(server.OAuthClientID) != ""
	if result.NeedsManual {
		result.Instructions = "该服务不支持自动注册（DCR）—— 请在下面填入服务方给你的 client_id / client_secret 后再授权"
	}
	return result, nil
}

// OAuthStart 开始一次授权：定 client（传参 > 库里 > DCR）→ 拼授权地址 → 记 pending。
func (s *mcpService) OAuthStart(ctx context.Context, id int64, redirectURI, scope, clientID, clientSecret string) (OAuthStartResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return OAuthStartResult{}, ErrMCPNotFound
		}
		return OAuthStartResult{}, err
	}
	redirectURI = strings.TrimSpace(redirectURI)
	if redirectURI == "" {
		return OAuthStartResult{}, fmt.Errorf("%w: 回调地址不能为空（前端按当前访问 origin 传）", ErrMCPInvalid)
	}
	authServer, meta, err := mcp.DiscoverAuthServer(ctx, s.oauthHTTPClient(ctx, server), server.URL)
	if err != nil {
		return OAuthStartResult{}, err
	}
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)
	if clientID == "" {
		clientID = strings.TrimSpace(server.OAuthClientID)
		clientSecret = strings.TrimSpace(server.OAuthClientSecret)
	}
	if clientID == "" {
		// DCR：拿不到就直接报错 → 界面给两个手填框（口径 16-11）
		registeredID, registeredSecret, regErr := mcp.RegisterClient(ctx, s.oauthHTTPClient(ctx, server), meta, redirectURI, "krss")
		if regErr != nil {
			if errors.Is(regErr, mcp.ErrDCRUnsupported) {
				return OAuthStartResult{}, fmt.Errorf("%w：请手填 client_id / client_secret 后重试", mcp.ErrDCRUnsupported)
			}
			return OAuthStartResult{}, regErr
		}
		clientID, clientSecret = registeredID, registeredSecret
	}
	state, err := mcp.NewState()
	if err != nil {
		return OAuthStartResult{}, err
	}
	verifier, err := mcp.NewVerifier()
	if err != nil {
		return OAuthStartResult{}, err
	}
	// client 凭证进库（token 先沿用旧的 —— 换到新的才覆盖，避免开始一次授权就把旧 token 弄丢）。
	server.OAuthClientID = clientID
	server.OAuthClientSecret = clientSecret
	server.OAuthAuthServer = authServer
	if err := s.servers.UpdateOAuthTokens(ctx, server.ID, server); err != nil {
		return OAuthStartResult{}, err
	}
	storeOAuthPending(state, oauthPending{
		serverID:      server.ID,
		verifier:      verifier,
		clientID:      clientID,
		clientSecret:  clientSecret,
		redirectURI:   redirectURI,
		authServer:    authServer,
		tokenEndpoint: meta.TokenEndpoint,
		scope:         scope,
		expires:       time.Now().Add(10 * time.Minute),
	})
	authURL := mcp.BuildAuthorizeURL(meta, clientID, redirectURI, scope, server.URL, verifier, state)
	logger.Info("mcp oauth started", "module", "service", "action", "oauth_start", "resource", "mcp_server", "result", "ok",
		"mcp_server_id", server.ID, "host", network.ExtractHost(server.URL))
	return OAuthStartResult{AuthURL: authURL, State: state}, nil
}

// OAuthCallback 回调换 token（state 单次有效）→ 进库。
func (s *mcpService) OAuthCallback(ctx context.Context, state, code string) (model.MCPServer, error) {
	pending, ok := takeOAuthPending(strings.TrimSpace(state))
	if !ok {
		return model.MCPServer{}, fmt.Errorf("%w: 授权已过期或 state 无效，请回到设置里重新点「授权」", ErrMCPInvalid)
	}
	if strings.TrimSpace(code) == "" {
		return model.MCPServer{}, fmt.Errorf("%w: 授权被拒绝（没有拿到 code）", ErrMCPInvalid)
	}
	server, err := s.servers.GetByID(ctx, pending.serverID)
	if err != nil {
		return model.MCPServer{}, err
	}
	tokens, err := mcp.ExchangeCode(ctx, s.oauthHTTPClient(ctx, server), pending.tokenEndpoint, pending.clientID, pending.clientSecret, code, pending.redirectURI, pending.verifier)
	if err != nil {
		s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
		return model.MCPServer{}, err
	}
	applyTokens(&server, pending, tokens)
	if err := s.servers.UpdateOAuthTokens(ctx, server.ID, server); err != nil {
		return model.MCPServer{}, err
	}
	s.markStatus(ctx, server, nil, server.ToolCount, server.ResourceCount)
	logger.Info("mcp oauth authorized", "module", "service", "action", "oauth_callback", "resource", "mcp_server", "result", "ok",
		"mcp_server_id", server.ID, "token_fp", oauthTokenFingerprint(tokens.AccessToken))
	return MaskMCPServer(server), nil
}

func applyTokens(server *model.MCPServer, pending oauthPending, tokens mcp.OAuthTokens) {
	server.AuthType = model.MCPAuthOAuth
	server.OAuthClientID = pending.clientID
	server.OAuthClientSecret = pending.clientSecret
	server.OAuthAuthServer = pending.authServer
	server.OAuthAccessToken = tokens.AccessToken
	if tokens.RefreshToken != "" {
		server.OAuthRefreshToken = tokens.RefreshToken
	}
	server.OAuthExpiresAt = tokens.ExpiresAt
	server.OAuthTokenType = tokens.TokenType
	server.OAuthScope = tokens.Scope
}

// OAuthRevoke 撤销授权（清 token 与 secret，client_id 留着下次还能用）。
func (s *mcpService) OAuthRevoke(ctx context.Context, id int64) error {
	if _, err := s.servers.GetByID(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrMCPNotFound
		}
		return err
	}
	return s.servers.ClearOAuth(ctx, id)
}

// oauthHeaders 取这次出网要带的头：OAuth 且已授权 → Bearer；过期且有 refresh → 先刷新。
// 返回的 map 是新造的，不动 server.Headers（调用方可能并发用）。
func (s *mcpService) oauthHeaders(ctx context.Context, server model.MCPServer) (map[string]string, error) {
	headers := map[string]string{}
	for key, value := range server.Headers {
		headers[key] = value
	}
	if server.AuthType != model.MCPAuthOAuth {
		return headers, nil
	}
	if !server.OAuthAuthorized() {
		failure := model.MCPFailure{
			Bucket:     model.MCPFailureAuth,
			Code:       "not_authorized",
			Title:      "尚未授权",
			Suggestion: "点「授权」走完 OAuth 流程后再试",
		}
		return nil, &oauthFailureError{failure: failure}
	}
	if server.OAuthTokenExpired() {
		if strings.TrimSpace(server.OAuthRefreshToken) == "" {
			failure := model.MCPFailure{
				Bucket:     model.MCPFailureAuth,
				Code:       "token_expired",
				Title:      "授权已过期，且没有 refresh token",
				Suggestion: "点「重新授权」再走一次流程",
			}
			return nil, &oauthFailureError{failure: failure}
		}
		refreshed, err := s.refreshOAuthTokens(ctx, server)
		if err != nil {
			return nil, err
		}
		server = refreshed
	}
	headers["Authorization"] = firstNonEmptyOAuth(server.OAuthTokenType, "Bearer") + " " + server.OAuthAccessToken
	return headers, nil
}

// oauthFailureError 把「还没开始连就知道的认证问题」包成 error，同时带上结构化失败。
type oauthFailureError struct {
	failure model.MCPFailure
}

func (e *oauthFailureError) Error() string { return e.failure.Title }

// refreshOAuthTokens 自动刷新并进库（token 端点从 auth_server 的元数据重读 ——
// 服务可能换地址，存的 tokenEndpoint 不做长期信任）。
func (s *mcpService) refreshOAuthTokens(ctx context.Context, server model.MCPServer) (model.MCPServer, error) {
	authServer := strings.TrimSpace(server.OAuthAuthServer)
	var tokenEndpoint string
	if authServer != "" {
		if _, meta, err := mcp.DiscoverAuthServer(ctx, s.oauthHTTPClient(ctx, server), server.URL); err == nil {
			tokenEndpoint = meta.TokenEndpoint
		}
	}
	if tokenEndpoint == "" {
		return server, &oauthFailureError{failure: model.MCPFailure{
			Bucket:     model.MCPFailureAuth,
			Code:       "no_token_endpoint",
			Title:      "找不到 token 端点，刷新失败",
			Suggestion: "点「重新授权」再走一次流程",
		}}
	}
	tokens, err := mcp.RefreshTokens(ctx, s.oauthHTTPClient(ctx, server), tokenEndpoint, server.OAuthClientID, server.OAuthClientSecret, server.OAuthRefreshToken)
	if err != nil {
		return server, &oauthFailureError{failure: mcp.Classify(err, server.URL)}
	}
	// refresh 回来可能没有新的 refresh_token —— 沿用旧的（别把唯一的续命绳弄丢）。
	if tokens.RefreshToken == "" {
		tokens.RefreshToken = server.OAuthRefreshToken
	}
	server.OAuthAccessToken = tokens.AccessToken
	server.OAuthRefreshToken = tokens.RefreshToken
	server.OAuthExpiresAt = tokens.ExpiresAt
	if tokens.TokenType != "" {
		server.OAuthTokenType = tokens.TokenType
	}
	if tokens.Scope != "" {
		server.OAuthScope = tokens.Scope
	}
	if err := s.servers.UpdateOAuthTokens(ctx, server.ID, server); err != nil {
		return server, err
	}
	logger.Info("mcp oauth refreshed", "module", "service", "action", "oauth_refresh", "resource", "mcp_server", "result", "ok",
		"mcp_server_id", server.ID, "token_fp", oauthTokenFingerprint(server.OAuthAccessToken))
	return server, nil
}

// oauthTokenFingerprint token 指纹（日志/界面只许出现这个，不许出现真值）。
func oauthTokenFingerprint(token string) string {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(sum[:])[:12]
}

func firstNonEmptyOAuth(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
