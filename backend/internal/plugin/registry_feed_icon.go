package plugin

import "sort"

// FeedIconProviders 返回所有「已启用且实现了 FeedIconProvider」的插件，按插件 id 排序。
//
// 口径与 Decorators()/EntryProcessors()/FetchClassifiers() 完全一致：只看已启用插件、
// 类型断言 FeedIconProvider、按 id 排序、注入 PluginID。
func (r *Registry) FeedIconProviders() []NamedFeedIconProvider {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := make([]string, 0, len(r.plugins))
	for id := range r.plugins {
		if !r.enabled[id] {
			continue
		}
		if _, ok := r.plugins[id].(FeedIconProvider); ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	out := make([]NamedFeedIconProvider, 0, len(ids))
	for _, id := range ids {
		out = append(out, NamedFeedIconProvider{
			PluginID: id,
			Provider: r.plugins[id].(FeedIconProvider),
		})
	}
	return out
}
