package plugin

import (
	"context"

	"krss/backend/internal/model"
)

// FeedIconProvider 是可选扩展点：插件可为一个订阅源提供它应使用的图标 URL。
//
// 它不是 Plugin 接口的一部分——插件按需实现它，宿主通过 *Registry.FeedIconProviders()
// 收集所有「已启用且实现了该接口」的插件。图标 URL 由宿主统一下载落盘，插件只负责给出地址。
type FeedIconProvider interface {
	ID() string
	// FeedIcon 返回这条订阅应使用的图标 http(s) URL；空串 = 不认这条订阅。
	FeedIcon(ctx context.Context, feed model.Feed) (string, error)
}

// NamedFeedIconProvider 把扩展点与所属插件 id 绑在一起，便于宿主记录日志/排障。
type NamedFeedIconProvider struct {
	PluginID string
	Provider FeedIconProvider
}
