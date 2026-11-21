package plugin

import (
	"errors"
	"io/fs"
)

// 56-24 沙箱 UI 资源通道。
//
// 插件可以自带 HTML/JS（新视图、面板），宿主用
//
//	<iframe sandbox="allow-scripts" src="/api/plugins/<id>/ui/index.html">
//
// 加载它。**同源路径、但 opaque origin**：iframe 里的脚本拿不到宿主的 cookie、DOM、localStorage，
// 也不能 fetch 宿主接口（CSP 的 connect-src 'none' 再兜一道）——插件界面只能靠 postMessage 与宿主说话，
// 「插件把阅读器改坏」这条风险因此被关在 iframe 里。
//
// 资源来源两条轨（宿主对前端是同一个 URL，插件作者不必关心自己在哪条轨上）：
//   - 内置插件：实现 UIAssets 返回 embed.FS，宿主用 http.FileServer 直接服务（零拷贝、无进程）；
//   - 外部插件：不实现 UIAssets，宿主把 GET /ui/<rest> 代理到插件进程的 socket（协议见 remote.go）。
//
// 权限：两种轨都必须声明 PermissionUICustom。它不是一个「技术开关」而是一句承诺——
// 声明了它，插件才拿到一个能在用户浏览器里跑脚本的入口，宿主才肯把 /ui/ 打开。

// UIAssets 可选接口：插件自带界面资源（新视图、面板）。
// 内置插件返回 embed.FS；外部插件不实现它，宿主把请求代理到插件的 socket。
type UIAssets interface {
	UIAssets() fs.FS
}

// PermissionUICustom 声明「我有自定义界面」；没有它不许访问 /ui/。
const PermissionUICustom = "ui:custom"

// UISandboxCSP 沙箱界面的内容安全策略。
//
// 为什么这里**不绑定 origin**（不用 'self'，也不写死某个 host）：
//   1. 沙箱 iframe 是 `sandbox="allow-scripts"`（不给 allow-same-origin）⇒ 文档是 opaque origin，
//      CSP 的 'self' 匹配的是「文档自己的源」，一个源都匹配不到，插件自己的 `./bridge.js` 会被拦，
//      页面永远停在「加载中」；
//   2. 写死「服务它的那个 host」在开发态必错：前端 :5174 经 vite 代理到后端 :8082，
//      文档 URL 在 :5174 而后端只看得见 :8082，源对不上照样被拦。
//
// 所以策略按「允许加载、禁止出网」来定：脚本/样式/图片不限来源（插件本来就能带自己的代码），
// 但 `connect-src 'none'` 掐掉 fetch/XHR/WebSocket、`form-action`/`base-uri 'none'` 掐掉外发通道。
// **真正的安全边界是 sandbox（拿不到宿主 DOM/localStorage）+ bridge 的权限校验**，CSP 只是第二道。
const UISandboxCSP = "default-src * 'unsafe-inline' data: blob:; " +
	"script-src * 'unsafe-inline'; " +
	"style-src * 'unsafe-inline'; " +
	"img-src * data: blob:; " +
	"font-src * data:; " +
	"connect-src 'none'; form-action 'none'; base-uri 'none'"

// ErrUIAssetNotFound 外部插件没有这块界面资源（宿主据此回 404，而不是 502「插件坏了」）。
var ErrUIAssetNotFound = errors.New("plugin: 界面资源不存在")

// UIAssetFile 一份界面资源（外部插件经 socket 取回的字节流）。
// 内置插件这条路不走它 —— 那条是 FileServer 直接读 embed.FS。
type UIAssetFile struct {
	Body        []byte
	ContentType string
}

// DeclaresPermission 插件是否声明了某个权限。
// 内置插件同样按「声明」判定：自定义界面这等要开浏览器执行入口的能力，一律显式申请，
// 不因为是内置插件就默认放行（口径统一，外部/内置只有取资源的方式不同）。
func DeclaresPermission(meta Meta, permission string) bool {
	if permission == "" {
		return false
	}
	for _, item := range meta.Permissions {
		if item == permission {
			return true
		}
	}
	return false
}
