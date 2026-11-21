package plugin

// 56-27 视图注册。
//
// 一个「视图」= 视图切换器里的一格。插件可以注册两类：
//   - declarative：只声明「看哪些条目」（ViewQuery + Layout），怎么取、怎么画全由宿主负责。
//     这是默认形态 —— 插件不碰 DOM、不出网，宿主照着现有条目列表渲染，风险最低。
//   - custom：插件自带界面（Entry 指向 /api/plugins/:id/ui/ 下的 HTML），宿主用沙箱 iframe 装进去。
//     因为它要一个能在用户浏览器里跑脚本的入口，所以必须声明 PermissionUICustom（见 ui.go），
//     否则注册表直接丢弃 —— 不靠前端「记得别渲染」来兜底。
//
// 注册表负责三件宿主的事：只取已启用插件、按 plugin id 排序、注入 Plugin 字段（插件自己填不了别人的）。

// ViewQuery 声明式视图的取数条件（宿主翻成现有的条目列表查询）。
// 指针字段 = 「没提这件事」，与 false 区分开：Unread=nil 是「已读未读都要」，Unread=&false 是「只看已读」。
type ViewQuery struct {
	FeedIDs []int64  `json:"feedIds,omitempty"`
	Types   []string `json:"types,omitempty"`
	Unread  *bool    `json:"unread,omitempty"`
	Starred *bool    `json:"starred,omitempty"`
	Search  string   `json:"search,omitempty"`
	Sort    string   `json:"sort,omitempty"`
}

// View 插件注册的一个视图（出现在视图切换器里）。
type View struct {
	Plugin string     `json:"plugin,omitempty"` // 宿主注入
	ID     string     `json:"id"`
	Label  string     `json:"label"`
	Icon   string     `json:"icon,omitempty"`
	Kind   string     `json:"kind"` // "declarative" | "custom"
	Query  *ViewQuery `json:"query,omitempty"`
	Layout string     `json:"layout,omitempty"` // list|grid|timeline
	Entry  string     `json:"entry,omitempty"`  // custom 用：iframe 入口
	Open   string     `json:"open,omitempty"`   // ""|reader|external
	// Permissions 宿主注入：该插件声明的权限。沙箱 bridge 靠它决定给不给 data / entries:read。
	// 插件不用自己填（填了也会被覆盖成它 Meta 里那份）。
	Permissions []string `json:"permissions,omitempty"`
}

// 视图形态取值（View.Kind）。
const (
	ViewKindDeclarative = "declarative"
	ViewKindCustom      = "custom"
)

// ViewProvider 可选接口：插件注册视图。
type ViewProvider interface {
	Views() []View
}
