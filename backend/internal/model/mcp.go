package model

import (
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// MCP（16 批 · 入向 MCP 订阅 / 17 批 · 出向 Krss 作为 MCP 服务器）
// ---------------------------------------------------------------------------

// MCP 传输类型。streamable-http（2025-06-18 规范）+ sse（旧版 HTTP+SSE 传输）+ auto（默认：
// 按 JSON type / URL 特征 / 试错自动识别，并记住上次成功的那种 —— 16-10）。
const (
	MCPTransportStreamableHTTP = "streamable-http"
	MCPTransportSSE            = "sse"
	MCPTransportAuto           = "auto"
)

// MCP 认证类型。none / header（第一批）+ oauth（16-11：well-known 发现 → DCR → PKCE）。
const (
	MCPAuthNone   = "none"
	MCPAuthHeader = "header"
	MCPAuthOAuth  = "oauth"
)

// MCP 连接用途标记：同一份连接两种用途并存，不新造第二套配置（用户 2026-09-18 拍板）。
const (
	MCPPurposeAI   = "ai"   // 仅 AI 用（Folo 那种：给模型装工具）
	MCPPurposeFeed = "feed" // 用于 Feed（本需求：MCP 取到的内容当订阅条目）
)

// MCPServer 一条 MCP 连接。
// 存表不塞 KV 的理由：有连接状态 / 错误 / 计数，要被「建源向导」遍历与引用。
type MCPServer struct {
	ID        int64
	Name      string
	Transport string
	URL       string
	// Headers 仅 Header 认证时使用；属敏感数据 —— 出接口时掩码，日志里绝不出现值。
	Headers  map[string]string
	AuthType string
	Enabled  bool
	// 连接状态。IsConnected 只在「测试/取数成功」后置 true；LastError 是失败原因（行内红字用）。
	IsConnected   bool
	LastError     *string
	ToolCount     int
	ResourceCount int
	Purposes      []string
	// 取数时机（16-7）：UseGlobalFetch=true 跟全局（复用并发/超时/代理）；
	// 单独配了就**不走全局**（有些 MCP 有次数限额，需要单独控制频率）。
	UseGlobalFetch         bool
	FetchTimeoutSeconds    *int
	FetchConcurrency       *int
	RefreshIntervalMinutes *int
	// LastTransport 上次成功的传输（transport='auto' 时优先试它 —— 16-10）。
	// 空 = 还没成功过，按 streamable-http → sse 的顺序试。
	LastTransport string
	// OAuth 一套（16-11）。Secret / Token 出接口一律掩码，日志里绝不出现值。
	OAuthClientID     string
	OAuthClientSecret string
	OAuthAccessToken  string
	OAuthRefreshToken string
	OAuthExpiresAt    *time.Time
	OAuthTokenType    string
	OAuthScope        string
	OAuthAuthServer   string
	// LastFailure 上次失败的结构化 JSON（桶/细分/建议/原始返回 —— 16-12，三处共用）。
	LastFailure  *string
	LastUsedAt   *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// HasPurpose 该连接是否被标记为某个用途。
func (s MCPServer) HasPurpose(purpose string) bool {
	for _, p := range s.Purposes {
		if p == purpose {
			return true
		}
	}
	return false
}

// OAuthAuthorized 是否已走完授权（有 access token）。过期与否另看 OAuthTokenExpired。
func (s MCPServer) OAuthAuthorized() bool {
	return s.AuthType == MCPAuthOAuth && strings.TrimSpace(s.OAuthAccessToken) != ""
}

// OAuthTokenExpired token 是否已过期。没有过期时间 = 认为没过期（有些服务不给 expires_in）。
// 提前 60 秒算过期，避免「刚好卡在边界上」的 401。
func (s MCPServer) OAuthTokenExpired() bool {
	if s.OAuthExpiresAt == nil {
		return false
	}
	return time.Now().After(s.OAuthExpiresAt.Add(-time.Minute))
}

// SnowflakeID 出 JSON 时序列化成**字符串**的 int64。
// 项目铁律：Snowflake ID 超过 2^53，JS 侧只能用 string —— mcp_config 是原样透给前端的 JSON，
// 里面混一个数字 id 就会在大整数上丢精度（订阅与连接会对不上）。
type SnowflakeID int64

func (id SnowflakeID) Int64() int64 { return int64(id) }

func (id SnowflakeID) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(strconv.FormatInt(int64(id), 10))), nil
}

func (id *SnowflakeID) UnmarshalJSON(data []byte) error {
	raw := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if raw == "" || raw == "null" {
		*id = 0
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return err
	}
	*id = SnowflakeID(value)
	return nil
}

// MCPFeedConfig 是 feeds.mcp_config 里那份 JSON：这条订阅「怎么取数」。
// 只有 source_type = mcp 的订阅才有。
type MCPFeedConfig struct {
	ServerID SnowflakeID `json:"serverId"`
	// Kind：tool（调工具）或 resource（读资源）。第一版两者都支持。
	Kind        string         `json:"kind"`
	ToolName    string         `json:"toolName,omitempty"`
	ResourceURI string         `json:"resourceUri,omitempty"`
	Arguments   map[string]any `json:"arguments,omitempty"`
	// Limit 每次取一页的条数（默认只取一页 —— 否则首次接入会把几千条灌进来）。
	Limit   int              `json:"limit,omitempty"`
	Mapping MCPFieldMapping  `json:"mapping"`
	// Pagination 追历史配置（16-8：默认 single 只取一页；history 做单次调用内 cursor 循环）。
	Pagination *MCPPagination `json:"pagination,omitempty"`
	// Tier 建源时判定出的「四档」来源；KeyLevel 是去重键实际用了哪一级（界面只显示它）。
	Tier     string `json:"tier,omitempty"`
	KeyLevel string `json:"keyLevel,omitempty"`
}

// MCPFieldMapping 声明式字段映射：列表路径 + 各字段的点号路径。
// 全部由后端自动预填、用户可手改（A1 已拍板：声明式为主，AI 只做第 4 档兜底）。
type MCPFieldMapping struct {
	// ListPath 列表路径（如 data.items / results / notes）。空 = 结果本身就是数组。
	ListPath string `json:"listPath,omitempty"`
	Title    string `json:"title,omitempty"`
	URL      string `json:"url,omitempty"`
	Content  string `json:"content,omitempty"`
	// PublishedAt 时间字段；Author 作者；ID 去重键字段（id / key / slug / url）。
	PublishedAt string `json:"publishedAt,omitempty"`
	Author      string `json:"author,omitempty"`
	ID          string `json:"id,omitempty"`
	Thumbnail   string `json:"thumbnail,omitempty"`
}

// Empty 判断映射是否什么都没配（建源向导里用来判「还没预填」）。
func (m MCPFieldMapping) Empty() bool {
	return m.ListPath == "" && m.Title == "" && m.URL == "" && m.Content == "" &&
		m.PublishedAt == "" && m.Author == "" && m.ID == "" && m.Thumbnail == ""
}

// MCP 四档（方案 §三）：映射从哪来，自动化程度依次降低。
const (
	MCPTierResource   = "resource"   // ① resource / resource_link：带 uri，几乎零映射
	MCPTierSchema     = "schema"     // ② 有 outputSchema：读 schema 直接生成
	MCPTierStructured = "structured" // ③ 有 structuredContent / JSON 文本、无 schema：按字段名预填
	MCPTierText       = "text"       // ④ 只有纯文本：先当 JSON 解析，再退 Markdown 切分，最后人工/AI
)

// MCP 去重键用了哪一级（照抄 computeEntryHash 的退化顺序）。
const (
	MCPKeyLevelField    = "key"        // 映射里指定的键字段（id / key / slug / url）
	MCPKeyLevelLink     = "link"       // 条目的链接字段
	MCPKeyLevelFallback = "title+time" // 兜底：标题 + 时间（只当兜底 —— 同名不同内容会被当成同一条）
)

// 失败 4 桶（16-12）：桶决定界面给什么出口按钮。
const (
	MCPFailureNetwork  = "network"  // 连不上/超时/DNS/TLS：建议查服务与网络
	MCPFailureAuth     = "auth"     // 401/403/token 过期：出口「去配 Header / 改用 OAuth」
	MCPFailureProtocol = "protocol" // 404/405/非 MCP 响应/传输出错：出口「一键切传输重试」等
	MCPFailureUpstream = "upstream" // 502/503/504：服务在网关后面
	MCPFailureUnknown  = "unknown"  // 兜底：没分进上面四桶的，一律有这桶
)

// MCPFailure 一次失败的结构化原因：结论一句话（人话）+ 一句建议 + 可复制的原始返回。
// 列表行 / 测试按钮 / 向导预览三处共用同一套。
type MCPFailure struct {
	Bucket     string `json:"bucket"`
	Code       string `json:"code"`
	Title      string `json:"title"`
	Suggestion string `json:"suggestion,omitempty"`
	Raw        string `json:"raw,omitempty"`
}

// 分页模式（16-8）：single = 每次取一页（默认，避免首次接入灌几千条）；
// history = 单次调用内 cursor 循环追历史（页数/条数双上限）。
const (
	MCPPaginationSingle  = "single"
	MCPPaginationHistory = "history"
)

// 追历史的默认双上限（16-8 口径：3 页 / 200 条）。
const (
	MCPPaginationDefaultMaxPages = 3
	MCPPaginationDefaultMaxItems = 200
)

// MCPPagination 取数分页配置（存在 feeds.mcp_config 里，不用新迁移）。
type MCPPagination struct {
	Mode string `json:"mode,omitempty"`
	// MaxPages 最多追几页；MaxItems 最多收几条（双上限，先到先停）。
	MaxPages int `json:"maxPages,omitempty"`
	MaxItems int `json:"maxItems,omitempty"`
	// CursorParam 传给工具的游标参数名（空 = 按 inputSchema 自动找 cursor/nextCursor/pageToken/offset/page）；
	// CursorPath 从返回里读下一页游标的路径（空 = 按 nextCursor/cursor/next_cursor/pageToken 自动找）。
	CursorParam string `json:"cursorParam,omitempty"`
	CursorPath  string `json:"cursorPath,omitempty"`
}

// Effective 取生效值（补默认）。
func (p *MCPPagination) Effective() (mode string, maxPages, maxItems int) {
	mode = MCPPaginationSingle
	maxPages = MCPPaginationDefaultMaxPages
	maxItems = MCPPaginationDefaultMaxItems
	if p == nil {
		return mode, maxPages, maxItems
	}
	if p.Mode == MCPPaginationHistory {
		mode = MCPPaginationHistory
	}
	if p.MaxPages > 0 {
		maxPages = p.MaxPages
	}
	if p.MaxItems > 0 {
		maxItems = p.MaxItems
	}
	return mode, maxPages, maxItems
}
