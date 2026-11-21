// 插件沙箱界面的静态资源通道（56-24 的插件侧，56-26 落到 SDK）。
//
// 宿主把 `/api/plugins/<id>/ui/<rest>` 原样代理到插件进程的 `GET /ui/<rest>`
// （见 internal/plugin/remote.go 的 UIAsset）。插件不必自己写 HTTP handler：
// 实现 `plugin.UIAssets` 返回一个 FS（一般 `//go:embed ui`）即可。
//
// bridge.js 例外：**永远发 SDK 内嵌的那份**（sdk/ui/bridge.js），插件目录里放同名文件也不生效。
// 它是插件与宿主协议的唯一真相源 —— 让每个插件各拷一份 150 行的胶水，等于让协议随插件版本漂。
package sdk

import (
	_ "embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"

	"krss/backend/internal/plugin"
)

//go:embed ui/bridge.js
var bridgeJS []byte

const bridgeJSName = "bridge.js"

// uiAsset 服务一块插件界面资源。目录根与 index.html 是同一份（宿主那边也这么折，
// 否则相对资源会在 301 之后按新目录解析）。
func (s *server) uiAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/ui/")
	if rest == "" || rest == "index.html" {
		rest = "index.html"
	}
	if rest == bridgeJSName {
		writeAsset(w, "text/javascript; charset=utf-8", bridgeJS)
		return
	}
	// 折叠 .. 的写法（../secret、a/../../b）一律 404：fs.ReadFile 也拒绝，但先在这里断掉
	// 「清理后变成另一个合法路径」这种（path.Clean 会把 /ui/../secret 折成 secret）。
	if clean := strings.TrimPrefix(path.Clean("/"+rest), "/"); clean != rest || rest == "" {
		http.NotFound(w, r)
		return
	}

	assets, ok := s.plugin.(plugin.UIAssets)
	if !ok {
		http.NotFound(w, r)
		return
	}
	fsys := assets.UIAssets()
	if fsys == nil {
		http.NotFound(w, r)
		return
	}
	body, err := fs.ReadFile(fsys, rest)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeAsset(w, contentTypeOf(rest), body)
}

// contentTypeOf 按扩展名给类型；认不出的按二进制流（宿主那边已 nosniff）。
func contentTypeOf(name string) string {
	if ext := path.Ext(name); ext != "" {
		if value := mime.TypeByExtension(ext); value != "" {
			return value
		}
	}
	return "application/octet-stream"
}

// writeAsset 统一三个头：类型、禁缓存（插件升级后页面立刻换新）、不再额外加 CSP
// （沙箱的 CSP 由宿主统一发，插件侧再发一份会互相打架）。
func writeAsset(w http.ResponseWriter, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
