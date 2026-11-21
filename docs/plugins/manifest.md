# plugin.json —— 外部插件清单

每个外部插件是一个目录，目录名必须等于 `id`，目录里必须有 `plugin.json`。宿主**只信这份磁盘清单**，不信插件进程自报的 `/meta`。

```json
{
  "id": "annotate",
  "name": "标注",
  "version": "0.1.0",
  "transport": "http",
  "entrypoint": "./annotate",
  "autostart": false,
  "capabilities": ["decorate"],
  "permissions": ["entries:read", "data", "ui:custom"],
  "contributions": [],
  "views": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 全局唯一，规则/设置/数据都用它。只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`，不能包含 `.removed-`。必须与目录名一致。 |
| `name` | 是 | 设置页显示名。 |
| `version` | 是 | 插件版本，建议语义化版本。 |
| `transport` | 否 | 空值按 `http` 处理；外部插件固定 `http`。 |
| `entrypoint` | 是 | 可执行文件相对路径（相对插件目录），必须是存在的普通文件。 |
| `autostart` | 否 | 仅作为首次登记时的默认启用建议；当前安全策略下**所有新发现外部插件一律先停用**，需要在界面手动打开。 |
| `capabilities` | 否 | 能力标签，供展示/排障用，不参与权限判定。 |
| `permissions` | 否 | 向宿主申请的数据能力，见下表。 |
| `contributions` | 否 | 界面贡献声明，见 [ui.md](ui.md)。 |
| `views` | 否 | 视图声明，见 [ui.md](ui.md)。 |

## permissions

| 值 | 含义 |
| --- | --- |
| `entries:read` | 界面直调时可拿到条目的标题、链接、摘要（不含正文）。 |
| `entries:full` | 在 `entries:read` 基础上包含正文；蕴含 `entries:read`。 |
| `feeds:read` | 可拿到订阅源信息。 |
| `filters:read` | 可拿到过滤规则信息。 |
| `data` | 可使用插件专属数据存储（`plugin_data`）与 bridge 的 `data.*`。 |
| `export` | 可通过 `InvokeResult.Files` 产出导出文件。 |
| `network` | 声明需要访问网络（外部进程本身不受限，此声明用于提示/审计）。 |
| `ui:custom` | 允许注册 `kind: "custom"` 视图并访问 `/api/plugins/<id>/ui/*` 沙箱资源。 |

`permissions` 不是沙箱：外部插件终究是本机进程。它只决定宿主在直调、bridge 和视图资源上**给不给数据/入口**。

## 上传包限制

「添加插件」只接受 `.zip`：

- 包大小 ≤ 64MB，解压后总量 ≤ 256MB，文件数 ≤ 2000。
- `plugin.json` 可以在 zip 根目录，也可以在唯一的顶层目录内；Finder 压缩产生的 `__MACOSX/`、`.DS_Store`、`._*` 会自动跳过。
- 拒绝绝对路径、`..` 越界路径、符号链接。
- `id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`；`name`、`version` 不能为空；`transport` 只能省略（默认 `http`）或显式写 `http`。
- `entrypoint` 必须是包内已存在的普通文件；上传时若缺可执行位会自动补上。
- `id` 已存在（包括内置插件 id）→ 409，不会覆盖。
- 安装成功后插件目录落在数据目录 `plugins/<id>/`，插件默认停用。
