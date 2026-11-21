# 外部进程协议（Unix socket + JSON）

外部插件由宿主拉起后可执行文件，监听宿主指定的 Unix socket。协议版本为 **v1**（`apiVersion: 1`），与前端沙箱 bridge v1 同步演进但相互独立。

## 连接与鉴权

- socket 路径：`KRSS_PLUGIN_SOCKET`（宿主创建在 `plugins/<id>/plugin.sock`，权限 0600）。
- token：`KRSS_PLUGIN_TOKEN`，**每个请求**都必须带 `X-Krss-Plugin-Token` 头，否则 401。
- 插件 id：`KRSS_PLUGIN_ID`，宿主以此覆盖 `/meta` 里的 `id` 并强制 `builtin=false`。
- 宿主 API 基址：`KRSS_PLUGIN_API`（插件需要回调宿主时使用）。
- 不开 TCP、不监听局域网。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/ready` | 就绪探针，200 即就绪 |
| GET | `/meta` | Meta + 扩展点清单 + `apiVersion` |
| GET | `/settings` | 读插件设置 `{"values":{...}}` |
| PUT | `/settings` | 覆盖设置 `{"values":{...}}` |
| POST | `/actions/<actionId>/execute` | 执行动作 |
| POST | `/actions/<actionId>/test` | 动作自测 |
| POST | `/actions/<actionId>/invoke` | 界面直调 |
| POST | `/entry-processors/<id>` | 阅读期处理 |
| POST | `/fetch-classifiers/<id>` | 抓取失败归类 |
| POST | `/decorate` | 正文装饰 |
| GET | `/ui/<path>` | 插件自带界面资源 |

SDK `sdk.Serve(ctx, p)` 已实现上述全部路由，插件作者只需要实现 Go 接口。下面给出协议报文，便于非 Go 实现或调试。

## GET /meta

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "一句话说明",
  "version": "0.1.0",
  "builtin": false,
  "apiVersion": 1,
  "actions": [
    {"actionId": "notify", "label": "发通知", "fields": [
      {"key": "url", "label": "地址", "type": "text", "required": true}
    ]}
  ],
  "sections": [
    {"id": "main", "title": "设置", "fields": []}
  ],
  "entryProcessors": [{"id": "marker"}],
  "fetchClassifiers": [{"id": "rsshub"}]
}
```

宿主校验 `apiVersion`；不匹配时拒绝启动该插件（不进入崩溃重启循环）。

## 设置

```json
GET /settings  →  {"values": {"token": "***"}}
PUT /settings  ←  {"values": {"token": "abc"}}
```

SDK 把设置写到插件目录下的 `settings.json`（0600）。外部插件不直接写 Krss 数据库。

## 动作

`POST /actions/<id>/execute`

```json
← {"filter": {...}, "feed": {...}, "entry": {...}, "config": {"note": "hi"}}
→ {}
→ {"error": "地址没填"}
```

`POST /actions/<id>/test`：请求体 `{}`，成功 `{}`，失败 `{"error":"..."}`。

`POST /actions/<id>/invoke`（界面直调）：

```json
← {
    "surface": "entry.contextmenu",
    "selection": {"entryIds": ["2124014887091834880"], "feedIds": []},
    "config": {"text": "..."},
    "entries": [...],
    "feeds": [...],
    "filter": {...}
  }
→ {"message": "已导出", "level": "success", "refresh": ["entries"], "files": [
    {"filename": "krss/2026-11-21 标题.md", "content": "...", "mime": "text/markdown"}
  ]}
```

注意：条目/订阅 id 是 19 位整数，宿主一律用 **JSON 字符串**传，避免 JavaScript 精度丢失；SDK 的 `Selection.UnmarshalJSON` 也兼容数字形式。

## 阅读期处理

`POST /entry-processors/<id>`

```json
← {"feed": {...}, "entry": {...}}
→ {"entry": {...}}
→ {"error": "..."}
```

## 抓取失败归类

`POST /fetch-classifiers/<id>`

```json
← {"feed": {...}, "statusCode": 403, "bodyHead": "<base64>", "error": "..."}
→ {"message": "需要登录或验证码"}
```

`bodyHead` 是 base64 编码的响应体前若干字节。

## 正文装饰

`POST /decorate`

```json
← {"entry": {...}, "text": "纯文本正文"}
→ {"decorations": [
    {"id": "d1", "start": 5, "end": 8, "style": "highlight", "color": "#ff0", "data": {}}
  ]}
```

`start/end` 是纯文本 rune 下标。宿主校验越界并回填 `data["text"]`。

## 界面资源

`GET /ui/<path>` 返回插件目录里的静态文件。宿主会套 CSP 并放进 `sandbox="allow-scripts"` iframe；`bridge.js` 由宿主/SDK 提供，插件页面用 `<script src="./bridge.js">` 引入即可。详见 [ui.md](ui.md)。
