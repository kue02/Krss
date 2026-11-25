package service

import (
	"errors"

	"krss/backend/internal/model"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrInvalid   = errors.New("invalid")
	ErrFeedFetch = errors.New("feed fetch failed")
	// ErrUpdateCheckFailed 检查自身更新时请求 GitHub 失败（网络/限流/响应异常）—— handler 回 502。
	ErrUpdateCheckFailed = errors.New("update check failed")
	// ErrUnknownSettingKey 导入设置时出现白名单以外的键（21 批）——
	// 单独一个错误是为了给前端一句能看懂的话（列出到底哪个键不认），而不是笼统的 400。
	ErrUnknownSettingKey = errors.New("unknown setting key")
)

// PluginModuleError plugin 模块（55 批）。
var (
	ErrPluginNotFound          = errors.New("plugin not found")
	ErrPluginDisabled          = errors.New("plugin disabled")
	ErrPluginActionNotTestable = errors.New("plugin action not testable")
	// 56-5 界面直调：动作没装 / 没实现 Invoker / 这个 surface 没声明它，三种错要让前端能分辨。
	ErrPluginActionNotFound     = errors.New("plugin action not found")
	ErrPluginActionNotInvokable = errors.New("plugin action is not invokable")
	ErrPluginSurfaceUndeclared  = errors.New("plugin action is not declared for this surface")
	// 插件专属数据（56-19）：这个部署没挂数据仓储（plugin_data 表在、但没接进 service）。
	// 单独一个错是为了让 500 日志一眼看出是装配漏了，而不是被当成插件的问题。
	ErrPluginDataUnavailable = errors.New("plugin data storage is not available")
	// ErrPluginDataQuota 该插件的数据键已到上限（每插件 10 万键）—— 409，让插件自己清理。
	ErrPluginDataQuota = errors.New("plugin data key quota exceeded")
	// ErrPluginUnreachable 联系不上插件进程（没起 / 已退出 / 超时）—— handler 回 502。
	ErrPluginUnreachable = errors.New("plugin is unreachable")
	// 沙箱 UI 资源（56-24）：没声明 ui:custom / 声明了却没给资源，两种错要分开报
	// （前者是权限问题=403，后者是插件自己装漏了=404）。
	ErrPluginUIUndeclared  = errors.New("plugin has not declared ui:custom")
	ErrPluginUIUnavailable = errors.New("plugin ui assets unavailable")
	// ErrPluginBuiltinCannotUninstall 内置插件不可卸载（只能停用）—— 卸载走 409。
	ErrPluginBuiltinCannotUninstall = errors.New("内置插件不可卸载，只能停用")
	// 插件包上传（56-36）：zip 结构 / manifest / entrypoint 不合法、目标 id 已存在。
	ErrPluginPackageInvalid = errors.New("插件包不合法")
	ErrPluginPackageExists  = errors.New("插件已存在")
	// ErrPluginProtocolIncompatible 外部插件自报的协议版本与宿主不一致 —— 永久错误，不重试。
	// 单独一个哨兵让 startLocked 能 fail-fast，而不是当成普通崩溃看护 5 轮。
	ErrPluginProtocolIncompatible = errors.New("插件协议版本不兼容")
)

// FeedConflictError is returned when a feed URL already exists.
type FeedConflictError struct {
	ExistingFeed model.Feed
}

func (e *FeedConflictError) Error() string {
	return "feed already exists"
}

func (e *FeedConflictError) Is(target error) bool {
	return target == ErrConflict
}

// PluginActionError 插件**正常回话但报了错**（「先选中文字」「地址没填」这类）。
// 与 ErrPluginUnreachable 分开：这个给 4xx + 插件原话，用户改一下就能过；
// 那个是网关故障（502），改参数没用。
type PluginActionError struct {
	Reason string
}

func (e PluginActionError) Error() string { return e.Reason }

// Unwrap 让 errors.Is(err, ErrPluginActionFailed) 成立。
func (e PluginActionError) Unwrap() error { return ErrPluginActionFailed }

// ErrPluginActionFailed 插件动作失败（总类；具体原因见 PluginActionError.Reason）。
var ErrPluginActionFailed = errors.New("plugin action failed")
