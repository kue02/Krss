package ui

import (
	_ "embed"
	"os"
	"strings"
	"testing"
)

// bridge.js 是插件页面**唯一**的运行时依赖（不给插件塞构建链），也是 SDK 与宿主协议的唯一真相源。
// 它是 .js 不是 .go —— 没有编译器看着，误删/改坏只会在用户打开插件视图时才炸。
// 所以这里用 go:embed 钉住三条：文件在、入口在、还是发给 window.parent。
//
//go:embed bridge.js
var bridgeJS string

// TestBridgeScript_Exists 文件必须真的在磁盘上，且不是空壳（注释 + API 一起 >1KB）。
// embed 只能证明「构建时在」，os.Stat 另外防「有人把它改成 0 字节」。
func TestBridgeScript_Exists(t *testing.T) {
	info, err := os.Stat("bridge.js")
	if err != nil {
		t.Fatalf("bridge.js 必须放在 sdk/ui/ 下（插件页面靠 ./bridge.js 引）：%v", err)
	}
	if info.Size() == 0 {
		t.Fatal("bridge.js 是空文件")
	}
	if len(bridgeJS) < 1000 {
		t.Fatalf("bridge.js 只有 %d 字节，像是被截断了（完整版约 150 行）", len(bridgeJS))
	}
}

// TestBridgeScript_ExposesWindowKrss 插件页面只认 `window.krss` 这个入口；
// 改名等于把所有插件页一并改坏。
func TestBridgeScript_ExposesWindowKrss(t *testing.T) {
	if !strings.Contains(bridgeJS, "window.krss") {
		t.Fatal(`bridge.js 必须挂在 window.krss 上（插件页面按这个入口调用）`)
	}
	for _, name := range []string{"onInit", "onEvent", "ready", "theme"} {
		if !strings.Contains(bridgeJS, name) {
			t.Fatalf("bridge.js 缺入口 %s（见 sdk/ui/bridge.js 的对外契约）", name)
		}
	}
}

// TestBridgeScript_PostsToParentWithWildcard 沙箱 iframe 的 origin 是 opaque，
// 宿主认不出来、也没法给出具体 origin，所以目标只能是 "*"；且必须只发 window.parent
// （发 top / 广播等于把插件数据递给别的窗口）。
func TestBridgeScript_PostsToParentWithWildcard(t *testing.T) {
	if !strings.Contains(bridgeJS, "window.parent.postMessage(") {
		t.Fatal(`bridge.js 必须用 window.parent.postMessage( 发消息（不是 top、不是广播）`)
	}
	if !strings.Contains(bridgeJS, `"*"`) {
		t.Fatal(`bridge.js 的 postMessage 目标 origin 必须是 "*"（opaque origin 下唯一可行值）`)
	}
	if strings.Contains(bridgeJS, "top.postMessage") {
		t.Fatal("bridge.js 不许往 top 发（宿主可能是被嵌的）")
	}
}
