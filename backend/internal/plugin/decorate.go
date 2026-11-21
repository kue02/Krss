package plugin

import (
	"context"

	"krss/backend/internal/model"
)

// 56-21 正文装饰契约：插件不许碰 DOM，只声明「哪一段、什么样式」，怎么画由宿主决定。
//
// 偏移基准 = 宿主递给插件的那份纯文本（`DecorateRequest.Text`），**rune 计数**，不是字节偏移
// （否则中文条目上插件算出的区间会整体往右漂）。宿主负责剥 HTML 并在回收时按同一份文本校验区间。

// DecorateRequest 宿主把「这条目的纯文本」交给插件，偏移基准就是它（rune 计数）。
type DecorateRequest struct {
	Entry model.Entry `json:"entry"`
	Text  string      `json:"text"`
}

// Decoration 插件声明的一段装饰：只给区间与样式，怎么画由宿主决定。
type Decoration struct {
	Plugin string            `json:"plugin"` // 宿主注入
	ID     string            `json:"id"`
	Start  int               `json:"start"`
	End    int               `json:"end"`
	Style  string            `json:"style"` // highlight|underline|note
	Color  string            `json:"color,omitempty"`
	Data   map[string]string `json:"data,omitempty"`
}

// RenderDecorator 可选接口：给某条目返回装饰区间（插件不碰 DOM）。
type RenderDecorator interface {
	Decorate(ctx context.Context, req DecorateRequest) ([]Decoration, error)
}

// NamedDecorator 带归属插件 id 的装饰器（宿主聚合时用；id 由注册表填，插件自己填不了）。
type NamedDecorator struct {
	PluginID  string
	Decorator RenderDecorator
}
