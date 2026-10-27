//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
)

// PluginMaskedValue 出接口的掩码（凭据不进前端、不进日志；照 MCP 的 ••••••••）。
const PluginMaskedValue = "••••••••"

// IsMaskedPluginValue 前端回传的是不是「没改过的掩码值」——是就保持原值。
func IsMaskedPluginValue(value string) bool { return value == PluginMaskedValue }

// PluginSettingsResult 一个插件的设置值（secret 字段掩码）。
type PluginSettingsResult struct {
	Values map[string]string `json:"values"`
}

type PluginService interface {
	// Catalog 全部插件清单（含能力）。顺带做两件事：
	//   ① ensureBuiltin —— 表里没有的内置插件补进行（bark/rsshub 默认开 ⇒ 行为零变化；demo 默认关）
	//   ② ensureExternal —— 扫 $KRSS_DATA_DIR/plugins/，新发现的外部插件读 manifest、落库、拉起（55-7b）
	// 所以「清单接口」本身就是安装/卸载的发现通道：设置页每次打开都会过一次。
	Catalog(ctx context.Context) ([]plugin.CatalogItem, error)
	// SetEnabled 改启停：内存注册表即时生效 + 落库。
	SetEnabled(ctx context.Context, id string, enabled bool) ([]plugin.CatalogItem, error)
	// GetSettings 读插件设置（secret 掩码）。
	GetSettings(ctx context.Context, id string) (PluginSettingsResult, error)
	// PutSettings 写插件设置；值为掩码 = 不改这一项。
	PutSettings(ctx context.Context, id string, values map[string]string) (PluginSettingsResult, error)
	// TestAction 让动作自己发一条测试（Bark「发送测试推送」）。
	TestAction(ctx context.Context, id, actionID string) error
	// Contributions 全部已启用插件贡献的界面项（按 surface 分组、已清洗去重；没有就是空 map）。
	// 只读内存注册表 —— 不带 ensureBuiltin/ensureExternal（启停位由 Catalog 那条链装载过）。
	Contributions(ctx context.Context) map[plugin.Surface][]plugin.Contribution
	// Decorations 聚合所有启用插件的正文装饰（56-21）：单个插件 300ms 超时，出错/超时只跳过并 warn，
	// 绝不阻塞阅读；条目查不到或没挂条目读端回空数组（不是错误）。
	Decorations(ctx context.Context, entryID int64) ([]plugin.Decoration, error)
	// UIAssets 一个插件自带界面资源的入口（56-24）：内置插件给 embed.FS、外部插件给 socket 代理。
	// 插件不存在 / 停用 / 没声明 ui:custom 分别回 ErrPluginNotFound / ErrPluginDisabled / ErrPluginUIUndeclared。
	UIAssets(ctx context.Context, pluginID string) (PluginUIAssets, error)
	// Views 全部已启用插件注册的视图（56-27）：视图切换器一份数据。
	// 清洗（custom 要 ui:custom、kind 兜底、同插件去重）、按 plugin id 排序、注入 plugin 都在注册表那层。
	Views(ctx context.Context) []plugin.View
	// Invoke 界面直调一个插件动作（56-5）：校验 surface 声明与 selection，再按插件声明的权限裁剪上下文。
	Invoke(ctx context.Context, pluginID, actionID string, req plugin.InvokeRequest) (plugin.InvokeResult, error)
	// 插件专属数据（56-19）—— 只能碰自己的 collection；停用的插件读写一律拒。
	// 值是不透明字符串（插件自己的 JSON），本体不解析。
	//   GetData 不存在 = ErrNotFound（404）；DeleteData 键不在 = ErrNotFound。
	//   ListData 的 limit 缺省 200、上限 1000（超了收敛，不报错）。
	GetData(ctx context.Context, pluginID, collection, key string) (string, error)
	PutData(ctx context.Context, pluginID, collection, key, value string) error
	DeleteData(ctx context.Context, pluginID, collection, key string) error
	ListData(ctx context.Context, pluginID, collection, prefix string, limit int) (map[string]string, error)
	DeleteDataCollection(ctx context.Context, pluginID, collection string) error
}

type pluginService struct {
	registry *plugin.Registry
	plugins  repository.PluginRepository
	settings repository.SettingsRepository
	// host 外部插件宿主（55-7b）。nil = 只跑内置轨（老测试 / 纯内置部署）。
	host *PluginHost
	// 界面直调（56-5）需要的只读能力。nil = 不补明细（只把选择原样递给插件，不报错）。
	entries InvokeEntryReader
	feeds   InvokeFeedReader
	filters InvokeFilterReader
	// data 插件专属数据（56-19，迁移 34 的表）。nil = 该部署没开这块（调用回 ErrPluginDataUnavailable）。
	data repository.PluginDataRepository
}

// InvokeEntryReader / InvokeFeedReader / InvokeFilterReader 是界面直调需要的只读能力。
// 故意只要 GetByID —— 与 repository 的同名方法形状一致，接线时直接传现有仓储即可。
type InvokeEntryReader interface {
	GetByID(ctx context.Context, id int64) (model.Entry, error)
}

type InvokeFeedReader interface {
	GetByID(ctx context.Context, id int64) (model.Feed, error)
}

type InvokeFilterReader interface {
	GetByID(ctx context.Context, id int64) (model.Filter, error)
}

// PluginServiceOption 可选装配（不塞进必填参数，老调用点零改动）。
type PluginServiceOption func(*pluginService)

// WithPluginHost 挂上外部插件宿主：Catalog 时扫插件目录，启停联动起停进程，设置/动作测试路由过去。
func WithPluginHost(host *PluginHost) PluginServiceOption {
	return func(s *pluginService) { s.host = host }
}

// WithInvokeRepos 挂上界面直调用的只读仓储（56-5）。不挂也能跑：只是不补条目/订阅/规则明细。
func WithInvokeRepos(entries InvokeEntryReader, feeds InvokeFeedReader, filters InvokeFilterReader) PluginServiceOption {
	return func(s *pluginService) {
		s.entries = entries
		s.feeds = feeds
		s.filters = filters
	}
}

// WithPluginDataRepo 挂上插件专属数据仓储（56-19，迁移 34 的 plugin_data 表）。
// 不挂 ⇒ GetData/PutData 等回 ErrPluginDataUnavailable（500），不会静默丢数据。
func WithPluginDataRepo(data repository.PluginDataRepository) PluginServiceOption {
	return func(s *pluginService) { s.data = data }
}

func NewPluginService(registry *plugin.Registry, plugins repository.PluginRepository, settings repository.SettingsRepository, opts ...PluginServiceOption) PluginService {
	svc := &pluginService{registry: registry, plugins: plugins, settings: settings}
	for _, opt := range opts {
		opt(svc)
	}
	return svc
}

// ensureBuiltin 把表里没有的内置插件补进行（默认启用 ⇒ 老实例升级后行为零变化）。
// 首次落库的启用位按 Meta.DefaultEnabled：nil = 开；demo 这类样板设 false ⇒ 装而不启。
func (s *pluginService) ensureBuiltin(ctx context.Context) error {
	existing := make(map[string]bool)
	states, err := s.plugins.List(ctx)
	if err != nil {
		return err
	}
	for _, st := range states {
		existing[st.ID] = st.Enabled
	}
	for _, meta := range s.registry.Plugins() {
		if _, ok := existing[meta.ID]; ok {
			continue
		}
		enabled := true
		if meta.DefaultEnabled != nil {
			enabled = *meta.DefaultEnabled
		}
		if err := s.plugins.Upsert(ctx, meta.ID, enabled); err != nil {
			return err
		}
	}
	// 用库里的记录覆盖注册表默认值
	loaded := make(map[string]bool, len(states))
	for _, st := range states {
		loaded[st.ID] = st.Enabled
	}
	s.registry.LoadEnabled(loaded)
	return nil
}

func (s *pluginService) Catalog(ctx context.Context) ([]plugin.CatalogItem, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return nil, err
	}
	s.ensureExternal(ctx)
	items := s.registry.Catalog()
	if s.host != nil {
		s.host.Decorate(items)
	}
	return items, nil
}

// ensureExternal 扫插件目录让外部插件收敛（即装即用；55-7b）。
// 单个插件起不来不算清单接口的错（错在插件不在宿主）——宿主已把原因写进 state，Decorate 会带到清单里。
func (s *pluginService) ensureExternal(ctx context.Context) {
	if s.host == nil {
		return
	}
	if err := s.host.Ensure(ctx); err != nil {
		logger.Error("external plugin scan failed",
			"module", "service", "action", "scan", "resource", "plugin", "result", "failed", "error", err)
	}
}

// isExternal 这个 id 是不是外部插件（磁盘上有 manifest，或宿主正看护它）。
func (s *pluginService) isExternal(id string) bool {
	return s.host != nil && s.host.Has(id)
}

func (s *pluginService) SetEnabled(ctx context.Context, id string, enabled bool) ([]plugin.CatalogItem, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return nil, err
	}
	s.ensureExternal(ctx)
	external := s.isExternal(id)
	if enabled {
		// 外部插件停用时是「进程不在 + 注册表摘除」，所以先把它拉起来再改启停位。
		if external {
			if err := s.host.Start(ctx, id); err != nil {
				return nil, err
			}
		}
		if !s.registry.SetEnabled(id, true) {
			return nil, ErrPluginNotFound
		}
		if err := s.plugins.Upsert(ctx, id, true); err != nil {
			return nil, err
		}
		return s.Catalog(ctx)
	}
	if !s.registry.SetEnabled(id, false) {
		return nil, ErrPluginNotFound
	}
	if err := s.plugins.Upsert(ctx, id, false); err != nil {
		return nil, err
	}
	// 停用 = 进程真的收走（SIGTERM → 宽限 → SIGKILL），再摘注册表。
	if external {
		s.host.StopPlugin(id)
	}
	return s.Catalog(ctx)
}

// settingsPrefix 插件设置键前缀（与 plugin.Settings 同一约定）。
func settingsPrefix(id string) string { return "plugin." + id + "." }

// secretFieldKeys 该插件全部 secret 字段的完整键（掩码判断用）。
func (s *pluginService) secretFieldKeys(id string) map[string]bool {
	out := map[string]bool{}
	for _, item := range s.registry.Catalog() {
		if item.ID != id {
			continue
		}
		for _, section := range item.Sections {
			for _, key := range plugin.SecretKeys(item.Meta, section.Fields) {
				out[key] = true
			}
		}
		for _, action := range item.Actions {
			for _, key := range plugin.SecretKeys(item.Meta, action.Fields) {
				out[key] = true
			}
		}
	}
	return out
}

func (s *pluginService) GetSettings(ctx context.Context, id string) (PluginSettingsResult, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return PluginSettingsResult{}, err
	}
	// 外部插件的设置在插件进程里（插件目录下的 settings.json），不走 krss 的 DB。
	if s.isExternal(id) {
		values, err := s.host.GetSettings(ctx, id)
		if err != nil {
			return PluginSettingsResult{}, err
		}
		return PluginSettingsResult{Values: s.maskRemoteSettings(id, values)}, nil
	}
	setting, err := s.settings.GetByPrefix(ctx, settingsPrefix(id))
	if err != nil {
		return PluginSettingsResult{}, err
	}
	secrets := s.secretFieldKeys(id)
	values := make(map[string]string, len(setting))
	for _, setting := range setting {
		key := strings.TrimPrefix(setting.Key, settingsPrefix(id))
		if secrets[setting.Key] && setting.Value != "" {
			values[key] = PluginMaskedValue
			continue
		}
		values[key] = setting.Value
	}
	return PluginSettingsResult{Values: values}, nil
}

// remoteSecretKeys 该插件 secret 字段的**裸键**（外部插件的设置值不带 plugin.<id>. 前缀）。
func (s *pluginService) remoteSecretKeys(id string) map[string]bool {
	prefix := settingsPrefix(id)
	full := s.secretFieldKeys(id)
	out := make(map[string]bool, len(full))
	for key := range full {
		out[strings.TrimPrefix(key, prefix)] = true
	}
	return out
}

// maskRemoteSettings 外部插件设置的出参掩码（与内置轨同一套 ••••••••）。
func (s *pluginService) maskRemoteSettings(id string, values map[string]string) map[string]string {
	secrets := s.remoteSecretKeys(id)
	out := make(map[string]string, len(values))
	for key, value := range values {
		if secrets[key] && value != "" {
			out[key] = PluginMaskedValue
			continue
		}
		out[key] = value
	}
	return out
}

// remoteSettingsToWrite 把前端提交合并到插件现有设置上（掩码回传 = 这一项没改，保持原值）。
// 外部插件的 PUT /settings 是整体替换，所以必须先读再合并。
func (s *pluginService) remoteSettingsToWrite(ctx context.Context, id string, incoming map[string]string) (map[string]string, error) {
	current, err := s.host.GetSettings(ctx, id)
	if err != nil {
		return nil, err
	}
	secrets := s.remoteSecretKeys(id)
	out := make(map[string]string, len(current)+len(incoming))
	for key, value := range current {
		out[key] = value
	}
	for key, value := range incoming {
		if strings.TrimSpace(key) == "" {
			continue
		}
		if secrets[key] && IsMaskedPluginValue(value) {
			continue
		}
		out[key] = value
	}
	return out, nil
}

func (s *pluginService) PutSettings(ctx context.Context, id string, values map[string]string) (PluginSettingsResult, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return PluginSettingsResult{}, err
	}
	if s.isExternal(id) {
		merged, err := s.remoteSettingsToWrite(ctx, id, values)
		if err != nil {
			return PluginSettingsResult{}, err
		}
		if _, err := s.host.PutSettings(ctx, id, merged); err != nil {
			return PluginSettingsResult{}, err
		}
		return s.GetSettings(ctx, id)
	}
	secrets := s.secretFieldKeys(id)
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		full := settingsPrefix(id) + key
		// 掩码回传 = 用户没改这一项：保持原值（没有就什么都不写）
		if secrets[full] && IsMaskedPluginValue(value) {
			continue
		}
		if err := s.settings.Set(ctx, full, value); err != nil {
			return PluginSettingsResult{}, err
		}
	}
	return s.GetSettings(ctx, id)
}

func (s *pluginService) TestAction(ctx context.Context, id, actionID string) error {
	if err := s.ensureBuiltin(ctx); err != nil {
		return err
	}
	a, ok := s.registry.LookupAction(id, actionID)
	if !ok {
		return ErrPluginNotFound
	}
	if !s.registry.Enabled(id) {
		return ErrPluginDisabled
	}
	tester, ok := a.(plugin.ActionTester)
	if !ok {
		return ErrPluginActionNotTestable
	}
	if err := tester.Test(ctx); err != nil {
		if errors.Is(err, plugin.ErrActionNotTestable) {
			return ErrPluginActionNotTestable
		}
		return err
	}
	return nil
}

// Contributions 各 surface 的界面贡献（只含已启用插件；丢弃/去重/默认 selection 都在注册表那层做完）。
func (s *pluginService) Contributions(ctx context.Context) map[plugin.Surface][]plugin.Contribution {
	// 启停位存在库里、只有 Catalog 那条链会装载。界面贡献是「打开页面就要对」的读，
	// 不能指望用户先点一次设置页：冷启动后直接进阅读页右键，也必须看到与库里一致的清单。
	// 两处 ensure 都是幂等的（补缺行 + 扫目录），失败不挡住读（退化成注册表默认值并留日志）。
	if s.plugins != nil {
		if err := s.ensureBuiltin(ctx); err != nil {
			logger.Warn("plugin contributions ensure builtin failed",
				"module", "service", "action", "contributions", "resource", "plugin", "result", "degraded", "error", err)
		}
	}
	s.ensureExternal(ctx)
	return s.registry.AllContributions()
}

// invokeEntryLimit 一次直调最多补多少条条目明细（前端多选撑死几百条，取数不该跟着无限涨）。
const invokeEntryLimit = 100

// 权限名（Meta.Permissions 的合法值，只对外部插件生效）。
const (
	permEntriesRead = "entries:read"
	permEntriesFull = "entries:full"
	permFeedsRead   = "feeds:read"
	permFiltersRead = "filters:read"
)

// findContribution 该插件是否在 surface 上声明了这个动作。
func findContribution(items []plugin.Contribution, surface plugin.Surface, actionID string) (plugin.Contribution, bool) {
	for _, item := range items {
		if item.Surface == surface && item.Action == actionID {
			return item, true
		}
	}
	return plugin.Contribution{}, false
}

// Invoke 界面直调一个插件动作（56-5）。
// 三道门：插件在不在/开没开 → 动作在不在 → 这个 surface 有没有声明它（界面能点的才算数）。
func (s *pluginService) Invoke(ctx context.Context, pluginID, actionID string, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	meta, ok := s.registry.Meta(pluginID)
	if !ok {
		return plugin.InvokeResult{}, ErrPluginNotFound
	}
	if !s.registry.Enabled(pluginID) {
		return plugin.InvokeResult{}, ErrPluginDisabled
	}
	action, ok := s.registry.LookupAction(pluginID, actionID)
	if !ok {
		return plugin.InvokeResult{}, ErrPluginActionNotFound
	}
	contribution, found := findContribution(s.registry.PluginContributions(pluginID), req.Surface, actionID)
	if !found {
		return plugin.InvokeResult{}, ErrPluginSurfaceUndeclared
	}
	if contribution.Selection != plugin.SelectionNone && req.Selection.IsEmpty() {
		return plugin.InvokeResult{}, ErrInvalid
	}
	invoker, ok := action.(plugin.Invoker)
	if !ok {
		return plugin.InvokeResult{}, ErrPluginActionNotInvokable
	}
	req.Plugin = pluginID
	req.Action = actionID
	req = s.enrichInvoke(ctx, meta, req)
	result, err := invoker.Invoke(ctx, req)
	if err == nil {
		return result, nil
	}
	// 分类（56-34）：联系不上插件 → 502；插件答话但报错 → 4xx + 插件原话。
	if errors.Is(err, plugin.ErrTransport) {
		return result, fmt.Errorf("%w: %s", ErrPluginUnreachable, err.Error())
	}
	reason := strings.TrimPrefix(err.Error(), plugin.ErrPluginError.Error()+": ")
	if reason == "" {
		reason = err.Error()
	}
	return result, PluginActionError{Reason: reason}
}

// enrichInvoke 按插件声明的权限补上下文（内置插件不裁剪，仍然补 —— 方便插件出文案）。
// 取不到的条目跳过并 warn：一条条目查不到不该让整个动作失败。
func (s *pluginService) enrichInvoke(ctx context.Context, meta plugin.Meta, req plugin.InvokeRequest) plugin.InvokeRequest {
	if s.entries == nil && s.feeds == nil && s.filters == nil {
		return req
	}
	granted := make(map[string]bool, len(meta.Permissions))
	for _, perm := range meta.Permissions {
		granted[perm] = true
	}
	// 内置插件编译在宿主里，本来就是同一份信任域 ⇒ 不裁剪。
	allowed := func(perm string) bool {
		if meta.Builtin || granted[perm] {
			return true
		}
		// 权限是**分层**的：entries:full（含正文）天然蕴含 entries:read（标题/链接/摘要）。
		// 不这么算的话，只申请 full 的插件反而拿不到条目 —— 标注插件导出就因此拿不到正文。
		if perm == permEntriesRead && granted[permEntriesFull] {
			return true
		}
		return false
	}

	if allowed(permEntriesRead) && s.entries != nil {
		ids := req.Selection.EntryIDs
		if len(ids) > invokeEntryLimit {
			logger.Warn("plugin invoke entry selection truncated",
				"module", "service", "action", "invoke", "resource", "plugin", "result", "partial",
				"plugin", meta.ID, "requested", len(ids), "limit", invokeEntryLimit)
			ids = ids[:invokeEntryLimit]
		}
		entries := make([]model.Entry, 0, len(ids))
		for _, id := range ids {
			entry, err := s.entries.GetByID(ctx, id)
			if err != nil {
				logger.Warn("plugin invoke entry lookup failed",
					"module", "service", "action", "invoke", "resource", "plugin", "result", "skipped",
					"plugin", meta.ID, "entry", id, "error", err)
				continue
			}
			if !allowed(permEntriesFull) {
				// 只有摘要权限：正文（含抓取后的可读正文）一律抹掉，其余字段保留。
				entry.Content = nil
				entry.ReadableContent = nil
			}
			entries = append(entries, entry)
		}
		req.Entries = entries
	}

	if allowed(permFeedsRead) && s.feeds != nil {
		// 订阅来源有两种来路：调用方直接给了 feedIds（订阅右键），
		// 或者只给了 entryIds（条目右键）——后者要按条目的 FeedID 反推，
		// 否则插件拿不到来源名，推送正文会缺「来源 · 」那一段。
		feedIDs := make([]int64, 0, len(req.Selection.FeedIDs)+len(req.Entries))
		seenFeed := make(map[int64]bool, len(req.Selection.FeedIDs)+len(req.Entries))
		for _, id := range req.Selection.FeedIDs {
			if !seenFeed[id] {
				seenFeed[id] = true
				feedIDs = append(feedIDs, id)
			}
		}
		for _, entry := range req.Entries {
			if !seenFeed[entry.FeedID] {
				seenFeed[entry.FeedID] = true
				feedIDs = append(feedIDs, entry.FeedID)
			}
		}
		feeds := make([]model.Feed, 0, len(feedIDs))
		for _, id := range feedIDs {
			feed, err := s.feeds.GetByID(ctx, id)
			if err != nil {
				logger.Warn("plugin invoke feed lookup failed",
					"module", "service", "action", "invoke", "resource", "plugin", "result", "skipped",
					"plugin", meta.ID, "feed", id, "error", err)
				continue
			}
			feeds = append(feeds, feed)
		}
		req.Feeds = feeds
	}

	if allowed(permFiltersRead) && s.filters != nil && req.Selection.FilterID != nil {
		filter, err := s.filters.GetByID(ctx, *req.Selection.FilterID)
		if err != nil {
			logger.Warn("plugin invoke filter lookup failed",
				"module", "service", "action", "invoke", "resource", "plugin", "result", "skipped",
				"plugin", meta.ID, "filter", *req.Selection.FilterID, "error", err)
		} else {
			req.Filter = &filter
		}
	}

	return req
}

// PluginIDByDataToken 用插件进程的 token 换它的插件 id（56-32 单库数据通道）。
// 不在 PluginService 接口里：只有真实现有宿主，mock 不需要它。
func (s *pluginService) PluginIDByDataToken(token string) (string, bool) {
	if s.host == nil {
		return "", false
	}
	return s.host.PluginIDByToken(token)
}
