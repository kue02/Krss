# Go 插件 API

内置插件和外部插件共用 `backend/internal/plugin` 这一套契约。外部插件只是用 `sdk.Serve` 把它托管到 Unix socket。

## 最小接口

```go
type Plugin interface {
    Meta() Meta
    Actions() []Action
    SettingsSections() []SettingsSection
    EntryProcessors() []EntryProcessor
    FetchClassifiers() []FetchClassifier
}
```

四个扩展点都可以返回 `nil`。

```go
type Meta struct {
    ID             string   `json:"id"`
    Name           string   `json:"name"`
    Description    string   `json:"description"`
    Version        string   `json:"version"`
    Builtin        bool     `json:"builtin"`
    Transport      string   `json:"transport,omitempty"`      // builtin | http
    DefaultEnabled *bool    `json:"defaultEnabled,omitempty"` // nil = 默认启用
    Permissions    []string `json:"permissions,omitempty"`
}
```

内置插件在包 `init()` 里 `plugin.MustRegister(New())`，并由 `backend/cmd/server/main.go` blank import 登记。外部插件的 `Meta.Builtin` 会被宿主强制视为 `false`，`ID` 以 manifest 为准。

## 动作 Action

```go
type Action interface {
    ID() string
    Label() string
    Fields() []Field
    Execute(ctx context.Context, req ActionRequest) error
}

type ActionRequest struct {
    Filter model.Filter
    Feed   model.Feed
    Entry  model.Entry
    Config map[string]string
}
```

规则命中后宿主按 `(pluginID, actionID)` dispatch。要支持「发送测试」再实现：

```go
type ActionTester interface {
    Test(ctx context.Context) error
}
```

要支持界面直调（右键菜单/工具栏/正文浮动条）再实现：

```go
type Invoker interface {
    Invoke(ctx context.Context, req InvokeRequest) (InvokeResult, error)
}
```

`InvokeResult` 可带 `Message/Level/Refresh`，以及 `Files []ExportFile`（导出文件，需要 `export` 权限）。

## 设置段 SettingsSection

```go
type SettingsSection struct {
    ID     string  `json:"id"`
    Title  string  `json:"title"`
    Fields []Field `json:"fields"`
}

type Field struct {
    Key         string   `json:"key"`
    Label       string   `json:"label"`
    Type        string   `json:"type"` // text | secret | select | bool
    Required    bool     `json:"required"`
    Placeholder string   `json:"placeholder,omitempty"`
    Help        string   `json:"help,omitempty"`
    Options     []Option `json:"options,omitempty"`
}
```

宿主把字段存在 `plugin.<插件 id>.<字段 key>`；`type: "secret"` 的键会自动进入设置导出的排除名单。插件侧读写可用：

```go
settings := plugin.Settings{PluginID: "my-plugin", Store: settingsRepo}
value := settings.Get(ctx, "token")
_ = settings.Set(ctx, "token", value)
```

## 阅读期处理 EntryProcessor

```go
type EntryProcessor interface {
    ID() string
    Matches(feed model.Feed, entry model.Entry) bool
    Process(ctx context.Context, entry model.Entry) (model.Entry, error)
}
```

- 宿主对**每个启用插件**串行调用；`Matches` 返回 false 就跳过。
- 每个插件有独立 2 秒超时，并继承请求的父 ctx。插件必须尊重 `ctx.Done()`，阻塞等待或网络请求要能取消。
- 返回错误时宿主记 warning 并保留原条目，不影响其他插件。

## 抓取失败归类 FetchClassifier

```go
type FetchClassifier interface {
    ID() string
    Classify(ctx context.Context, feed model.Feed, statusCode int, bodyHead []byte, fetchErr error) string
}
```

返回空串表示「不认这次失败」，交给下一家；返回非空字符串会作为用户可读原因展示。

## 正文装饰 RenderDecorator

```go
type RenderDecorator interface {
    Decorate(ctx context.Context, req DecorateRequest) ([]Decoration, error)
}

type DecorateRequest struct {
    Entry model.Entry `json:"entry"`
    Text  string      `json:"text"` // 宿主按纯文本口径给的正文
}

type Decoration struct {
    ID    string            `json:"id"`
    Start int               `json:"start"` // 纯文本 rune 下标
    End   int               `json:"end"`
    Style string            `json:"style"` // highlight | underline | note
    Color string            `json:"color,omitempty"`
    Data  map[string]string `json:"data,omitempty"`
}
```

宿主会校验 `start >= 0`、`end > start`、`end <= 正文 rune 长度`，并回填 `data["text"] = 原文片段` 作为重锚依据（插件自己填了则不覆盖）。不要操作 DOM。

## 界面贡献 / 视图

```go
type ContributionsProvider interface { Contributions() []Contribution }
type ViewProvider interface         { Views() []View }
type UIAssets interface             { UIAssets() fs.FS }
```

结构、挂点和沙箱说明见 [ui.md](ui.md)。

## 订阅源图标 FeedIconProvider

```go
type FeedIconProvider interface {
    ID() string
    FeedIcon(ctx context.Context, feed model.Feed) (string, error)
}
```

返回 http(s) 图标 URL，宿主统一下载、落盘、缓存；空串表示不认这条订阅。插件只给地址，不处理文件。内置 `githubavatar` 是参考实现。

## 其他可选接口

```go
type ActionTester interface { Test(ctx context.Context) error }
type Invoker      interface { Invoke(ctx context.Context, req InvokeRequest) (InvokeResult, error) }
```

## 错误约定

- 联系不上插件（进程没起 / socket 连不上 / 超时 / 报文坏）→ 宿主回 502。
- 插件正常收到请求但报错（参数不对、先选中文字等）→ 宿主回 4xx，`err.Error()` 原样给用户。
- 协议版本不兼容 → 宿主不重启插件，插件卡片显示错误，需要用新 SDK 重新编译。
