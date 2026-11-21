package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// decoratorPlugin 只做正文装饰的假插件（56-21）：记下收到的请求，按用例决定睡多久 / 返回什么。
type decoratorPlugin struct {
	id    string
	items []plugin.Decoration
	err   error
	delay time.Duration
	got   *plugin.DecorateRequest
}

func (p *decoratorPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true}
}
func (p *decoratorPlugin) Actions() []plugin.Action                   { return nil }
func (p *decoratorPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p *decoratorPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p *decoratorPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

func (p *decoratorPlugin) Decorate(ctx context.Context, req plugin.DecorateRequest) ([]plugin.Decoration, error) {
	if p.got != nil {
		*p.got = req
	}
	if p.delay > 0 {
		select {
		case <-time.After(p.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if p.err != nil {
		return nil, p.err
	}
	return p.items, nil
}

// newDecorationService 真注册表 + 真 service；条目录入端按用例给（nil = 不挂仓储）。
func newDecorationService(t *testing.T, entries service.InvokeEntryReader, plugins ...plugin.Plugin) service.PluginService {
	t.Helper()
	reg := plugin.NewRegistry()
	for _, p := range plugins {
		require.NoError(t, reg.Register(p))
	}
	return service.NewPluginService(reg, newFakePluginRepo(), newSettingsStub(),
		service.WithInvokeRepos(entries, nil, nil))
}

// TestPluginService_Decorations 正文装饰聚合（56-21）：并发问各插件、单个 300ms 超时、区间校验、稳定排序。
func TestPluginService_Decorations(t *testing.T) {
	ctx := context.Background()

	t.Run("单插件区间结果带上插件名且右文本是纯文本", func(t *testing.T) {
		var got plugin.DecorateRequest
		p := &decoratorPlugin{id: "aaa-note", got: &got, items: []plugin.Decoration{
			{ID: "n1", Start: 0, End: 3, Style: "highlight", Color: "#ff0", Data: map[string]string{"note": "现价"}},
		}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			7: {ID: 7, FeedID: 1, Content: stringPtr("<p>现价：<b>¥0.00</b></p><p>#机场</p>")},
		}}
		svc := newDecorationService(t, entries, p)

		out, err := svc.Decorations(ctx, 7)
		require.NoError(t, err)
		require.Len(t, out, 1)
		require.Equal(t, "aaa-note", out[0].Plugin, "宿主必须注入归属插件")
		require.Equal(t, "n1", out[0].ID)
		require.Equal(t, 0, out[0].Start)
		require.Equal(t, 3, out[0].End)
		require.Equal(t, "highlight", out[0].Style)
		require.Equal(t, "#ff0", out[0].Color)
		require.Equal(t, "现价", out[0].Data["note"])

		// 偏移基准就是递给插件的那份纯文本（HTML 剥掉、块级标签当空白、压成单空格）。
		require.Equal(t, int64(7), got.Entry.ID)
		require.Equal(t, "现价：¥0.00 #机场", got.Text, "递进来的是纯文本，不是原始 HTML")
	})

	t.Run("两插件重叠区间都返回且排序稳定", func(t *testing.T) {
		aaa := &decoratorPlugin{id: "aaa-deco", items: []plugin.Decoration{{ID: "a1", Start: 5, End: 9, Style: "underline"}}}
		bbb := &decoratorPlugin{id: "bbb-deco", items: []plugin.Decoration{
			{ID: "b1", Start: 0, End: 6, Style: "highlight"},
			{ID: "b2", Start: 2, End: 3, Style: "note"},
		}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{7: {ID: 7, Content: stringPtr("hello world")}}}
		svc := newDecorationService(t, entries, aaa, bbb)

		var first []plugin.Decoration
		for i := 0; i < 5; i++ {
			out, err := svc.Decorations(ctx, 7)
			require.NoError(t, err)
			require.Len(t, out, 3, "重叠不影响两家的区间都在册")
			if i == 0 {
				first = out
				continue
			}
			require.Equal(t, first, out, "并发聚合的结果每次必须一样（按 plugin/start/end 稳定排序）")
		}
		require.Equal(t, []string{"aaa-deco", "bbb-deco", "bbb-deco"}, pluginIDs(first))
		require.Equal(t, []int{5, 0, 2}, starts(first), "同插件内按 start 升序")
	})

	t.Run("插件超时被跳过其余照常且总耗时不拖住阅读", func(t *testing.T) {
		slow := &decoratorPlugin{id: "aaa-slow", delay: 400 * time.Millisecond, items: []plugin.Decoration{
			{ID: "slow", Start: 0, End: 2, Style: "highlight"},
		}}
		fast := &decoratorPlugin{id: "bbb-fast", items: []plugin.Decoration{{ID: "fast", Start: 0, End: 2, Style: "note"}}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{7: {ID: 7, Content: stringPtr("hello")}}}
		svc := newDecorationService(t, entries, slow, fast)

		start := time.Now()
		out, err := svc.Decorations(ctx, 7)
		elapsed := time.Since(start)

		require.NoError(t, err, "单个插件超时不算整体失败")
		require.Less(t, elapsed, time.Second, "总耗时要被 300ms 超时压住（不是串行等 400ms）")
		require.Len(t, out, 1)
		require.Equal(t, "bbb-fast", out[0].Plugin, "慢插件被跳过，快插件照常")
		require.Equal(t, "fast", out[0].ID)
	})

	t.Run("插件只给 start/end 时宿主回填 data.text 原文锚点", func(t *testing.T) {
		// 多段落 + 中文：htmlToPlain 把块级标签当空白再压成单空格 ⇒ "你好，世界 今天天气不错"
		// rune 下标：0你 1好 2， 3世 4界 5空格 6今 7天 8天 9气 10不 11错（共 12 runes）
		p := &decoratorPlugin{id: "aaa-anchor", items: []plugin.Decoration{
			{ID: "a", Start: 0, End: 5, Style: "highlight"},
			{ID: "b", Start: 2, End: 8, Style: "underline"}, // 跨段落边界，验证 rune 下标而非字节
			{ID: "c", Start: 6, End: 12, Style: "note"},
		}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{
			7: {ID: 7, Content: stringPtr("<p>你好，世界</p><p>今天天气不错</p>")},
		}}
		svc := newDecorationService(t, entries, p)

		out, err := svc.Decorations(ctx, 7)
		require.NoError(t, err)
		require.Len(t, out, 3)

		textByID := make(map[string]string, len(out))
		for _, d := range out {
			textByID[d.ID] = d.Data["text"]
		}
		require.Equal(t, "你好，世界", textByID["a"], "宿主回填的原文应等于正文对应片段")
		require.Equal(t, "，世界 今天", textByID["b"], "跨段落边界按 rune 切片，不能按字节切")
		require.Equal(t, "今天天气不错", textByID["c"])
	})

	t.Run("插件自带 data.text 时保持原值不被覆盖", func(t *testing.T) {
		p := &decoratorPlugin{id: "aaa-anchor", items: []plugin.Decoration{
			{ID: "own", Start: 0, End: 5, Style: "highlight", Data: map[string]string{"text": "插件自己的锚点"}},
			{ID: "bare", Start: 0, End: 5, Style: "highlight"},
		}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{7: {ID: 7, Content: stringPtr("hello 世界")}}}
		svc := newDecorationService(t, entries, p)

		out, err := svc.Decorations(ctx, 7)
		require.NoError(t, err)
		require.Len(t, out, 2)
		byID := make(map[string]plugin.Decoration, len(out))
		for _, d := range out {
			byID[d.ID] = d
		}
		require.Equal(t, "插件自己的锚点", byID["own"].Data["text"], "插件自带 text 不许覆盖")
		require.Equal(t, "hello", byID["bare"].Data["text"], "没说 text 的才由宿主补")
	})

	t.Run("越界区间被丢弃", func(t *testing.T) {
		p := &decoratorPlugin{id: "aaa-deco", items: []plugin.Decoration{
			{ID: "ok", Start: 0, End: 5, Style: "highlight"},
			{ID: "neg", Start: -1, End: 3, Style: "highlight"},
			{ID: "empty", Start: 3, End: 3, Style: "highlight"},
			{ID: "rev", Start: 4, End: 2, Style: "highlight"},
			{ID: "over", Start: 0, End: 9, Style: "highlight"},
		}}
		// "hello 世界" = 8 runes（无标签 ⇒ 纯文本，偏移基准好算）
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{7: {ID: 7, Content: stringPtr("hello 世界")}}}
		svc := newDecorationService(t, entries, p)

		out, err := svc.Decorations(ctx, 7)
		require.NoError(t, err)
		require.Len(t, out, 1, "start<0 / end<=start（含反向）/ end>len(runes) 四条都丢，且一条都不许拦腰截断")
		require.Equal(t, "ok", out[0].ID)
	})

	t.Run("插件报错被跳过", func(t *testing.T) {
		broken := &decoratorPlugin{id: "aaa-broken", err: errors.New("插件内部炸了")}
		ok := &decoratorPlugin{id: "bbb-ok", items: []plugin.Decoration{{ID: "ok", Start: 0, End: 2, Style: "highlight"}}}
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{7: {ID: 7, Content: stringPtr("hello")}}}
		svc := newDecorationService(t, entries, broken, ok)

		out, err := svc.Decorations(ctx, 7)
		require.NoError(t, err)
		require.Len(t, out, 1)
		require.Equal(t, "bbb-ok", out[0].Plugin)
	})

	t.Run("没有条目或没挂仓储回空数组不报错", func(t *testing.T) {
		p := &decoratorPlugin{id: "aaa-deco", items: []plugin.Decoration{{ID: "n1", Start: 0, End: 2, Style: "highlight"}}}

		// ① 仓储在，但这条查不到（删掉的条目 / 脏 id）
		entries := &invokeEntryRepo{entries: map[int64]model.Entry{}}
		svc := newDecorationService(t, entries, p)
		out, err := svc.Decorations(ctx, 999)
		require.NoError(t, err)
		require.NotNil(t, out, "空也得是空数组，不是 nil（HTTP 层要出 []）")
		require.Empty(t, out)

		// ② 整个部署没挂条目读端
		svcNoRepos := newDecorationService(t, nil, p)
		out, err = svcNoRepos.Decorations(ctx, 7)
		require.NoError(t, err)
		require.NotNil(t, out)
		require.Empty(t, out)
	})
}

// pluginIDs 取结果里的插件名序列（排序断言用）。
func pluginIDs(items []plugin.Decoration) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Plugin)
	}
	return out
}

// starts 取结果里的起始偏移序列。
func starts(items []plugin.Decoration) []int {
	out := make([]int, 0, len(items))
	for _, item := range items {
		out = append(out, item.Start)
	}
	return out
}
