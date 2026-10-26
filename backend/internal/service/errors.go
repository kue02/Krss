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
	// 沙箱 UI 资源（56-24）：没声明 ui:custom / 声明了却没给资源，两种错要分开报
	// （前者是权限问题=403，后者是插件自己装漏了=404）。
	ErrPluginUIUndeclared  = errors.New("plugin has not declared ui:custom")
	ErrPluginUIUnavailable = errors.New("plugin ui assets unavailable")
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
