# Krss 插件开发

Krss 的插件把「特化能力的实现」从本体里拆出来：本体继续管阅读体验与管理，Bark 推送、RSSHub 适配、GitHub 头像这类能力由插件提供。插件可以启停，但**不能改变本体行为语义**。

插件有两条轨道，同一份 Go 契约：

| 轨道 | 形态 | 怎么装 | 能否卸载 |
| --- | --- | --- | --- |
| 内置（builtin） | 编译进 `krss` 二进制 | 改代码、重新编译 | 不能，只能停用 |
| 外部（http） | 独立进程 + Unix socket | 设置 → 插件 →「添加插件」上传 zip，或放进数据目录 `plugins/<id>/` | 能，目录归档、数据清空 |

外部插件是**即装即用**的：上传后默认停用，确认来源可信再打开开关。宿主不把插件当成安全边界——插件的 `permissions` 是能力声明，不是沙箱；安装外部插件等于在本机运行它的代码。

## 5 分钟跑通一个外部插件

1. 新建目录 `my-plugin/`，写 `plugin.json`（字段见 [manifest.md](manifest.md)）：

   ```json
   {
     "id": "my-plugin",
     "name": "我的插件",
     "version": "0.1.0",
     "transport": "http",
     "entrypoint": "./my-plugin",
     "autostart": false,
     "permissions": ["entries:read"],
     "contributions": [],
     "views": []
   }
   ```

2. 写 `main.go`，用 SDK 托管（完整可运行示例见 `backend/cmd/examples/hello-menu/`）。注意 SDK 是 `krss/backend/internal/...` 的 internal 包，插件源码必须放在 backend 模块内（例如 `backend/cmd/my-plugin/`）；树外独立 module 无法直接 import internal 包：

   ```go
   package main

   import (
       "context"
       "krss/backend/internal/plugin"
       "krss/backend/internal/plugin/sdk"
   )

   type Plugin struct{}

   func (Plugin) Meta() plugin.Meta {
       return plugin.Meta{ID: "my-plugin", Name: "我的插件", Version: "0.1.0"}
   }
   func (Plugin) Actions() []plugin.Action                   { return nil }
   func (Plugin) SettingsSections() []plugin.SettingsSection { return nil }
   func (Plugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
   func (Plugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

   func main() {
       if err := sdk.Serve(context.Background(), Plugin{}); err != nil {
           panic(err)
       }
   }
   ```

3. 编译成可执行文件，命名为 `plugin.json` 里 `entrypoint` 指向的名字：

   ```bash
   cd my-plugin
   GOCACHE=/tmp/krss-gocache go build -o my-plugin .
   ```

4. 打包：`plugin.json` 放在 zip 根目录（或唯一顶层目录里）：

   ```bash
   zip -r my-plugin.zip plugin.json my-plugin
   ```

5. 打开 Krss → 设置 → 插件 →「添加插件」，选中 zip。安装成功后插件默认是「已停用」，打开开关后宿主会启动进程并握手。安装说明文字就在上传按钮下方。

## 插件能扩展什么

| 扩展点 | Go 接口 | 用途 |
| --- | --- | --- |
| 自动化动作 | `plugin.Action` | 过滤规则命中后执行动作（如推送） |
| 设置段 | `plugin.SettingsSection` | 在设置 → 插件里渲染配置表单 |
| 阅读期处理 | `plugin.EntryProcessor` | 对某类订阅源的条目做正文加工 |
| 抓取失败归类 | `plugin.FetchClassifier` | 把 403/验证码/RSSHub 错误翻成人话 |
| 界面贡献 | `plugin.ContributionsProvider` | 右键菜单、工具栏、正文浮动条等 9 个挂点 |
| 界面直调 | `plugin.Invoker` | 界面点按钮直接调用插件动作 |
| 自定义视图 | `plugin.ViewProvider` + `plugin.UIAssets` | 视图切换器里的沙箱 iframe 页面 |
| 正文装饰 | `plugin.RenderDecorator` | 高亮/下划线/批注区间，DOM 由宿主画 |
| 订阅源图标 | `plugin.FeedIconProvider` | 为订阅源提供头像/图标 URL |

接口签名与示例见 [go-api.md](go-api.md)；外部进程协议见 [protocol.md](protocol.md)；沙箱页面与 bridge 见 [ui.md](ui.md)。

## 生命周期与排障

- **发现**：宿主每 5 秒扫一次数据目录 `plugins/`。只认目录里的 `plugin.json`，目录名必须等于 `id`。名字里含 `.removed-` 的目录（形如 `<id>.removed-<UTC>`）是卸载归档，不会被扫描。
- **首次发现**：外部插件一律写入 `plugins` 表并置为**停用**；用户明确打开后才启动。
- **启动**：插件 SDK 自己 `net.Listen` 创建 `plugins/<id>/plugin.sock` 并 `Chmod 0600`；宿主只注入路径与环境变量 `KRSS_PLUGIN_SOCKET`、`KRSS_PLUGIN_TOKEN`、`KRSS_PLUGIN_ID`、`KRSS_PLUGIN_API`。插件进程只继承最小白名单环境变量，不再继承服务端全部环境。
- **协议**：宿主拉 `/meta`，校验 `apiVersion`。版本不兼容时**不重启**，只在插件卡片显示错误，避免旧二进制被反复拉起。
- **崩溃**：单个插件连续崩溃 5 次后停止看护并显示 `lastError`；其他插件不受影响。
- **日志**：`plugins/<id>/plugin.log`，启动时超过 5MB 会轮转。
- **读路径超时**：`EntryProcessor` 由宿主按单个插件 2 秒超时注入 `ctx`；插件必须尊重 `ctx.Done()`，否则宿主仍可能被同步调用拖住。
- **卸载**：外部插件目录改名为 `<id>.removed-<UTC>` 归档，同时清 `plugin_data`、`plugin.<id>.*` 设置和 `plugins` 行；内置插件只能停用。

## 安全边界

- 外部插件 = 本机代码。只在信任来源时安装、启用。
- `permissions` 只控制宿主**给插件多少数据**（例如 `entries:read` / `entries:full` / `data` / `ui:custom`），不是进程隔离。
- 插件界面跑在 `sandbox="allow-scripts"` 的 iframe 里：拿不到宿主 DOM、cookie、localStorage，`connect-src 'none'` 禁止 fetch/XHR/WebSocket；与宿主只通过 `postMessage` bridge 通信，bridge 按 `permissions` 放行。
- 插件设置里 `type: "secret"` 的字段会从设置导出中排除，界面回显时掩码。

## 相关文档

- [manifest.md](manifest.md) —— `plugin.json` 每个字段
- [go-api.md](go-api.md) —— Go 接口、请求/响应结构、权限
- [protocol.md](protocol.md) —— 外部进程 Unix socket + JSON 协议
- [ui.md](ui.md) —— 界面贡献、挂点、沙箱 bridge v1
- 运行时 HTTP API 见 `GET /swagger/index.html` 的 `plugins` 分组
