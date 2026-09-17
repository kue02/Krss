package model

import "time"

// 规则作用范围：全部 / 分类（文件夹）/ 单个订阅
const (
	FilterScopeAll    = "all"
	FilterScopeFolder = "folder"
	FilterScopeFeed   = "feed"
)

// 规则种类：
//   - rule：命中后执行动作（静音 / 已读 / 星标 / 自动翻译 / webhook…）—— 默认
//   - view：只筛条目、不写任何数据的「保存筛选视图」（侧栏快捷入口），引擎不会执行它
const (
	FilterKindRule = "rule"
	FilterKindView = "view"
)

// 条件可用字段（Handler 校验、前端下拉、引擎求值共用同一份白名单）
const (
	FilterFieldTitle        = "title"
	FilterFieldContent      = "content"
	FilterFieldAuthor       = "author"
	FilterFieldURL          = "url"
	FilterFieldPublishedAt  = "published_at"
	FilterFieldFeedTitle    = "feed_title"
	FilterFieldFeedURL      = "feed_url"
	FilterFieldFeedType     = "feed_type"
	FilterFieldFolder       = "folder"
	FilterFieldHasThumbnail = "has_thumbnail"
	FilterFieldIsRead       = "is_read"
	FilterFieldIsStarred    = "is_starred"
	// FilterFieldAIRelevance（P3）：把「这条与我给的主题相关吗」交给已配置的 AI provider 判断。
	// 条件里的 value 就是那句主题描述；判定结果按 (条目, 主题) 永久缓存，重复不会重复花钱。
	FilterFieldAIRelevance = "ai_relevance"
)

// 条件可用操作符
const (
	FilterOpContains   = "contains"
	FilterOpExact      = "exact"
	FilterOpRegex      = "regex"
	FilterOpBefore     = "before"
	FilterOpAfter      = "after"
	FilterOpOlderThan  = "older_than"
	FilterOpIsFuture   = "is_future"
	FilterOpIsEmpty    = "is_empty"
	FilterOpIsNotEmpty = "is_not_empty"
	// FilterOpIsRelevant 只配 ai_relevance 使用（value = 主题描述）；要「不相关」用条件的取反。
	FilterOpIsRelevant = "is_relevant"
)

// FilterConditionFields 与 FilterConditionOperators 是合法取值白名单。
var FilterConditionFields = []string{
	FilterFieldTitle,
	FilterFieldContent,
	FilterFieldAuthor,
	FilterFieldURL,
	FilterFieldPublishedAt,
	FilterFieldFeedTitle,
	FilterFieldFeedURL,
	FilterFieldFeedType,
	FilterFieldFolder,
	FilterFieldHasThumbnail,
	FilterFieldIsRead,
	FilterFieldIsStarred,
	FilterFieldAIRelevance,
}

var FilterConditionOperators = []string{
	FilterOpContains,
	FilterOpExact,
	FilterOpRegex,
	FilterOpBefore,
	FilterOpAfter,
	FilterOpOlderThan,
	FilterOpIsFuture,
	FilterOpIsEmpty,
	FilterOpIsNotEmpty,
	FilterOpIsRelevant,
}

// FilterCondition 一条条件。Logic 表示与「前一条」的连接词（首个条件忽略），Negate 对该条取反。
type FilterCondition struct {
	Logic    string `json:"logic"`
	Negate   bool   `json:"negate"`
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

// FilterActions 命中后的动作。正反成对（mute/unmute 等），由 UI 保证互斥。
// muted 语义：入库 + read=1 + muted=1（列表默认隐藏，但可回看、可反悔）。
type FilterActions struct {
	Mute       bool `json:"mute"`
	Unmute     bool `json:"unmute"`
	MarkRead   bool `json:"markRead"`
	MarkUnread bool `json:"markUnread"`
	Star       bool `json:"star"`
	Unstar     bool `json:"unstar"`
	KeepOnly   bool `json:"keepOnly"`
	// Translate / Summarize：给条目打「打开时自动翻译 / 自动摘要」标记。
	// 刻意不在入库时花 AI token —— 打标记，真正翻译发生在用户把这条打开的时候（复用既有 SSE 翻译通道）。
	Translate bool `json:"translate"`
	Summarize bool `json:"summarize"`
	// Webhook：命中后把这一条 POST 给外部地址（WebhookURL），投递失败会写在规则的 last_error 上。
	Webhook    bool   `json:"webhook"`
	WebhookURL string `json:"webhookUrl,omitempty"`
}

// IsEmpty 表示这条规则没有任何动作（视为无效规则）。
func (a FilterActions) IsEmpty() bool {
	return !a.Mute && !a.Unmute && !a.MarkRead && !a.MarkUnread && !a.Star && !a.Unstar &&
		!a.KeepOnly && !a.Translate && !a.Summarize && !a.Webhook
}

// AffectsMute 表示该动作组合会写入 muted 标记（静音或「只保留匹配」的落空分支）。
func (a FilterActions) AffectsMute() bool {
	return a.Mute || a.KeepOnly
}

// AffectsEntryAI 表示该动作组合会写入条目级的「打开时自动翻译 / 自动摘要」标记。
func (a FilterActions) AffectsEntryAI() bool {
	return a.Translate || a.Summarize
}

// Filter 一条过滤规则（Kind=view 时是「保存筛选视图」，引擎不执行）。
type Filter struct {
	ID            int64
	Name          string
	Enabled       bool
	Position      int
	Kind          string
	ScopeType     string
	ScopeID       *int64
	Conditions    []FilterCondition
	Actions       FilterActions
	MatchCount    int64
	LastMatchedAt *time.Time
	// LastError / LastErrorAt 是规则执行失败的可见出口（webhook 投递失败、AI 条件判定失败）。
	// 成功一次就清空 —— 规则表上直接能看到「上次为什么没生效」。
	LastError   *string
	LastErrorAt *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// FilterMatch 一条命中记录（审计 + 反悔依据）。
// EntryTitle / FeedTitle 是列表查询时带出来的（LEFT JOIN），条目被删就是空串 ——
// 命中日志要给人看，只有 entry_id 串没法读。
type FilterMatch struct {
	ID         int64
	FilterID   int64
	EntryID    int64
	EntryTitle string
	FeedTitle  string
	Actions    FilterActions
	CreatedAt  time.Time
}
