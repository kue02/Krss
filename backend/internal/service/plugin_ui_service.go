package service

import (
	"context"
	"io/fs"
	"time"

	"krss/backend/internal/plugin"
)

// 56-24 沙箱 UI 资源通道（service 侧）。
//
// 宿主对前端只暴露一个 URL（GET /api/plugins/:id/ui/*），两条轨的差别在这里收掉：
//   - 内置插件：给一个 fs.FS（embed.FS），handler 用 http.FileServer 直接服务；
//   - 外部插件：给一个 Proxy 闭包，把路径转成插件 socket 的 GET /ui/<rest>。
//
// 门禁三道，顺序固定：插件在不在（404）→ 开没开（409）→ 声明 ui:custom 没（403）。
// 权限判定对内置插件同样生效：自定义界面是「能跑脚本的入口」，谁要都得显式申请。

// uiAssetTimeout 外部插件取资源的超时（本地 socket 正常毫秒级；超了说明插件卡死，别把浏览器挂在 iframe 里）。
const uiAssetTimeout = 5 * time.Second

// PluginUIAssets 一个插件界面资源的入口（二选一，由 transport 决定）。
type PluginUIAssets struct {
	// Files 内置插件：embed.FS（handler 用 http.FileServer(http.FS(Files)) 服务）。
	Files fs.FS
	// Proxy 外部插件：按路径取一份字节（ctx 已带 5s 超时）。
	Proxy func(ctx context.Context, path string) (plugin.UIAssetFile, error)
}

// UIAssets 取一个插件的界面资源入口。
func (s *pluginService) UIAssets(ctx context.Context, pluginID string) (PluginUIAssets, error) {
	meta, ok := s.registry.Meta(pluginID)
	if !ok {
		return PluginUIAssets{}, ErrPluginNotFound
	}
	if !s.registry.Enabled(pluginID) {
		return PluginUIAssets{}, ErrPluginDisabled
	}
	if !plugin.DeclaresPermission(meta, plugin.PermissionUICustom) {
		return PluginUIAssets{}, ErrPluginUIUndeclared
	}
	if meta.Transport != plugin.TransportHTTP {
		p, ok := s.registry.Lookup(pluginID)
		if !ok {
			return PluginUIAssets{}, ErrPluginNotFound
		}
		assets, ok := p.(plugin.UIAssets)
		if !ok {
			return PluginUIAssets{}, ErrPluginUIUnavailable
		}
		files := assets.UIAssets()
		if files == nil {
			return PluginUIAssets{}, ErrPluginUIUnavailable
		}
		return PluginUIAssets{Files: files}, nil
	}
	// 外部插件：资源在插件进程那边（它自己的 web 目录），宿主只做转发。
	// 5s 超时在这里加（不是 handler 的事）：socket 客户端属于宿主。
	return PluginUIAssets{Proxy: func(ctx context.Context, path string) (plugin.UIAssetFile, error) {
		callCtx, cancel := context.WithTimeout(ctx, uiAssetTimeout)
		defer cancel()
		return s.host.UIAsset(callCtx, pluginID, path)
	}}, nil
}
