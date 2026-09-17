package model

import "time"

// 规则作用范围：全部 / 分类（文件夹）/ 单个订阅
const (
	FilterScopeAll    = "all"
	FilterScopeFolder = "folder"
	FilterScopeFeed   = "feed"
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
}

// IsEmpty 表示这条规则没有任何动作（视为无效规则）。
func (a FilterActions) IsEmpty() bool {
	return !a.Mute && !a.Unmute && !a.MarkRead && !a.MarkUnread && !a.Star && !a.Unstar && !a.KeepOnly
}

// AffectsMute 表示该动作组合会写入 muted 标记（静音或「只保留匹配」的落空分支）。
func (a FilterActions) AffectsMute() bool {
	return a.Mute || a.KeepOnly
}

// Filter 一条过滤规则。
type Filter struct {
	ID            int64
	Name          string
	Enabled       bool
	Position      int
	ScopeType     string
	ScopeID       *int64
	Conditions    []FilterCondition
	Actions       FilterActions
	MatchCount    int64
	LastMatchedAt *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// FilterMatch 一条命中记录（审计 + 反悔依据）。
type FilterMatch struct {
	ID        int64
	FilterID  int64
	EntryID   int64
	Actions   FilterActions
	CreatedAt time.Time
}
