# 界面贡献、视图与沙箱 bridge v1

插件可以往 9 个固定挂点插入界面项，也可以注册整个视图页面。外部插件在 `plugin.json` 的 `contributions` / `views` 里声明；内置插件实现 `ContributionsProvider` / `ViewProvider`。

## 9 个挂点（surface）

| Surface | 位置 |
| --- | --- |
| `entry.contextmenu` | 条目右键菜单 |
| `entry.list.toolbar` | 条目列表工具栏 |
| `entry.reader.toolbar` | 阅读器工具栏 |
| `entry.reader.body` | 阅读器正文浮动条 |
| `feed.contextmenu` | 订阅源右键菜单 |
| `filter.editor.footer` | 过滤规则编辑器底部 |
| `settings.section` | 设置弹窗插件页 |
| `app.command` | 命令面板 |
| `view.toolbar` | 视图工具栏 |

## Contribution

```json
{
  "id": "export-md",
  "surface": "entry.contextmenu",
  "action": "export",
  "label": "导出为 Markdown",
  "icon": "download",
  "group": "export",
  "confirm": "确定导出所选条目？",
  "selection": "multi",
  "refresh": ["entries"],
  "fields": [
    {"key": "dir", "label": "目录", "type": "text", "required": false}
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 同一 surface 内唯一 |
| `surface` | 上表之一；不支持的值会被宿主丢弃 |
| `op` | 可选操作标记；UI 用来区分同 surface 的不同行为 |
| `target` | 可选目标 |
| `action` | 交给插件 `Invoke` 的动作 id |
| `label` | 显示文字 |
| `icon` | 图标名（HeroUI 图标集） |
| `group` | 分组 |
| `confirm` | 点击前二次确认文案 |
| `fields` | 需要用户填的参数 |
| `selection` | `none` / `single` / `multi` |
| `refresh` | 调用成功后前端失效哪些缓存 |

`Plugin` 字段由宿主注入，插件不要填。

## View

```json
{
  "id": "stats",
  "label": "阅读统计",
  "icon": "chart",
  "kind": "declarative",
  "query": {"types": ["article"], "unread": true, "sort": "published_at_desc"},
  "layout": "list",
  "open": "reader"
}
```

| 字段 | 说明 |
| --- | --- |
| `kind` | `declarative`（用 query 由宿主查询）或 `custom`（沙箱 iframe 页面） |
| `query` | declarative 视图的筛选条件：`feedIds/types/unread/starred/search/sort` |
| `layout` | `list` / `grid` / `timeline` |
| `entry` | custom 视图的 iframe 入口（如 `index.html`） |
| `open` | `""` / `reader` / `external` |
| `permissions` | 宿主注入，插件填了也会被覆盖 |

`kind: "custom"` 必须声明 `ui:custom` 权限，否则宿主丢弃该视图。自定义视图的静态资源通过 `GET /api/plugins/<id>/ui/<path>` 提供。

## 沙箱页面

插件页面运行在：

```html
<iframe sandbox="allow-scripts" src="/api/plugins/<id>/ui/index.html"></iframe>
```

- opaque origin：拿不到宿主 DOM、cookie、localStorage。
- CSP `connect-src 'none'`：不能 fetch/XHR/WebSocket；`form-action`/`base-uri 'none'`。
- 与宿主只通过 `postMessage` 通信。

页面里引入 bridge：

```html
<script src="./bridge.js"></script>
<script>
  krss.ready();
  krss.onInit(function (init) {
    // init = {version, pluginId, permissions, locale, theme, entry?, view?}
    document.body.dataset.theme = init.theme.mode || "light";
  });

  const value = await krss.data.get("cache", "last");
  await krss.data.set("cache", "last", { at: Date.now() });
  const entry = await krss.entries.get("2124014887091834880");
  krss.toast("已保存");
  const ok = await krss.confirm("删除？", "删除后不可恢复");
  krss.navigate({ entryId: "2124014887091834880" });
</script>
```

## bridge v1 API

| 调用 | 说明 |
| --- | --- |
| `krss.version` | 协议版本，当前 `1` |
| `krss.ready()` | 通知宿主页面已加载 |
| `krss.onInit(fn)` | 接收 `host:init`；已到过会立刻回调 |
| `krss.onEvent(fn)` | 接收宿主主动事件（v1 预留） |
| `krss.data.get(collection, key)` | 读插件数据，返回字符串 |
| `krss.data.set(collection, key, value)` | 写插件数据；对象自动 JSON 序列化 |
| `krss.data.list(collection, prefix)` | 列键值 |
| `krss.data.remove(collection, key)` | 删键 |
| `krss.entries.get(id)` | 读条目；正文取决于 `entries:read` / `entries:full` |
| `krss.toast(message)` | 宿主提示条（不等回执） |
| `krss.confirm(title, body)` | HeroUI 确认框，返回 boolean |
| `krss.navigate({viewId\|entryId})` | 只允许切视图/打开条目 |
| `krss.theme()` | 宿主主题 CSS 变量 |

数据值一律是不透明字符串，宿主不改一个字节；`set` 传对象时 bridge 自己 JSON 序列化。所有需要回执的请求带自增 id、10 秒超时。

## 消息协议

插件 → 宿主：

```text
plugin:ready
plugin:data.get|set|list|remove   {id, collection, key?, value?, prefix?}
plugin:entries.get                {id, entryId}
plugin:ui.toast                   {message}
plugin:ui.confirm                 {id, title, body}
plugin:navigate                   {viewId|entryId}
plugin:export                     {id}
```

宿主 → 插件：

```text
host:init            {version, pluginId, permissions, locale, theme, entry?, view?}
host:data.result     {id, value?, error?}
host:entries.result  {id, entry?, error?}
host:confirm.result  {id, confirmed, error?}
host:export.result   {id, error?}
host:event           {…}（v1 预留）
```

安全规则：只向 `window.parent` 发；只收来自 `window.parent` 的 `host:*`；每条请求带 id 与超时。

## 插件数据配额

- 单值 ≤ 256KB
- 单插件 ≤ 100,000 个键
- key ≤ 200 字节
- collection 名由插件自定；卸载插件时整插件数据清除
