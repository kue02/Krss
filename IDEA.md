# Gist × Nextflux —— 给 Gist 换上 Nextflux 的界面

> 一句话：把 Gist（自托管 RSS 阅读器）的前端改造成 Nextflux 的界面与交互，保留 Gist 的多内容类型（文章 / 图片瀑布流 / 通知）与 AI 能力；**只给自己用**，不跟上游同步。

_更新时间：2026-09-16_

## 为什么

- 喜欢 Gist 的**内容形态**：多格式订阅、图片瀑布流（Folo 式图片流）、通知视图、Readability 沉浸阅读、AI 摘要/翻译、文件夹分层。
- 喜欢 Nextflux 的**界面**：暖灰石质配色、大圆角卡片列表（带缩略图）、浮层阅读面板、玻璃拟态 dropdown、胶囊筛选、细腻动效。
- 不想用 Miniflux（而 Nextflux 需要它当后端）→ 所以方向是**把 Nextflux 的界面搬到 Gist 上**，不是反过来。

## 已拍板的决策（2026-09-16）

| # | 决策 | 说明 |
|---|---|---|
| 1 | 基座 = **Gist 前端** | 不动 Go 后端业务逻辑；Nextflux 只作为界面/交互的参考与代码来源 |
| 2 | **引入 HeroUI v3** | `@heroui/react` + `@heroui/styles`（Nextflux 用 v3.0.4 + Tailwind 4）。动效/组件细节要 1:1，不手搓复刻 |
| 3 | 主题**照搬** Nextflux 全部 5 套 | 亮：light(白) / stone(石灰) / leaf；暗：dark(黑) / nord-dark(深蓝)，`data-theme` 驱动 |
| 4 | 交付**一步到位** | 本机 `~/Documents/Docker/` 下 Docker 部署；**NAS 暂不部署**（本机验收后再议） |
| 5 | **不跟进 Gist 上游** | 不 rebase、不合上游，改动可以放开手 |

## 需求清单

### 一、皮肤层（照搬 Nextflux 视觉语言）
- 设计 token：暖灰配色（底 `#e3e1de` / 面板 `#f5f3ef` / 字 `#3f3e3b` / 强调 `#df604d`）、圆角 18/24/28px、多层柔影 + 暗色内阴影、玻璃拟态（backdrop-blur）。
- 中栏文章列表改**卡片式**：160×160 缩略图（小图/大图/无图三档）、来源行 + favicon + 时间、2 行大标题、阅读时间、已读降透明度、选中项浮起。
- 中栏宽度：实测两侧比例已接近，**不收窄**（原「收窄到 420–580px」的方案已作废）。
- 正文区改**浮层圆角面板**（留 16px 外边距）+ 独立圆形按钮工具条。
- 侧栏：分组折叠、未读计数、选中胶囊态、底部账户栏。

### 二、功能移植（Nextflux 有、Gist 没有）
- 键盘快捷键 18 项 + 快捷键帮助弹窗。
- 外观/排版设置：字体族、字号、行高、标题/正文预览行数、卡片图片尺寸、动效开关。
- 多主题切换（亮/暗各选一套）。
- 中栏底部 Starred / Unread / All 胶囊筛选（Gist 后端已支持 `unreadOnly` / `starredOnly` / `hasThumbnail`，可直接接）。
- 图片画廊手势（Gist 已有 Lightbox，补缩放手势）。

### 二·补：Folo 式信息流（2026-09-16 用户追加）
- **社交媒体视图（第四类内容）**：与 文章 / 图片 / 通知 并排的独立标签页；**两栏布局**（侧栏 + 时间线主列，无独立列表列），
  点条目时内容在主列内替换时间线（带返回按钮）—— 照 Folo 的 wideMode 视图实现，不是在文章视图上加展开
- **滚动标已读**：沿用 Gist 的滚动标已读机制。
- **按视图单独设置**：四个视图各自可设「滚动标已读」（跟随通用 / 开 / 关）与
  「缺全文时自动抓取」（仅社交媒体视图；`scrollReadByView` / `fetchReadableByView`，存本机）。

### 二·补 2：动效与画面细节对齐 Nextflux（2026-09-16 用户追加）
- 卡片涟漪用 Nextflux 同款 `m3-ripple`（hoverOpacity=0 / pressedOpacity=0.05 / duration=100）。
- 已读卡片降透明度、主/危险按钮细描边+内高光+柔影、tooltip 胶囊、折叠缓动 ease-out、
  下拉与右键菜单玻璃底 + `shadow-nf-md`、浮层阅读面板。
- 待补：侧栏 hover/选中态过渡细节、骨架屏 shimmer 与 Nextflux 对齐、图片画廊手势。

### 三、必须保住的 Gist 能力（回归清单）
- 三视图：article / picture（瀑布流）/ notification。
- AI 摘要、AI 翻译（含批量）、Readability 沉浸模式、代码高亮。
- 图片代理、图标缓存、域名限流、OPML 导入导出、文件夹管理、未读计数。
- 移动端三档布局与 PWA。

## 技术路线

```
gist-nextflux/
├── IDEA.md                  # 本文件
├── docs/                    # 调研结论、差异清单、变更记录
├── app/                     # Gist 源码工作副本（Go 后端 + React/TS 前端）—— 只改 app/frontend/
├── references/
│   ├── gist-upstream/       # 上游 Gist（留 .git，便于日后 diff「我们改了什么」）
│   └── nextflux/            # Nextflux 源码（只读，抄组件/样式/主题时对照）
├── spike/                   # 一次性验证（跑通后结论回写 docs/）
└── scripts/                 # 可复用脚本（构建、部署、自检）
```

- 前端栈：React 19 + TS + Vite 8 + Tailwind 4.3 + Radix/react-query/zustand/wouter → **叠加 HeroUI v3**，保留 Gist 数据层。
- 主题：把 Nextflux 的 `data-theme` 五套 token 迁进 `app/frontend/src/index.css`，与 Gist 现有 CSS 变量做映射。
- 部署：`~/Documents/Docker/gist-nextflux/`（docker-compose + 本机构建镜像），NAS 暂缓。

## 后端补丁（唯一一处，为了「社交媒体」这一类内容）
Gist 的内容类型是后端枚举（`article/picture/notification`），要加第四类必须让后端认。
改动限于白名单与默认值，不动业务逻辑：
`handler/params.go`、`handler/entry_handler.go`、`handler/feed_handler.go`、`handler/folder_handler.go`、
`service/settings_service.go`（含：读取时补齐默认列表，老实例也能看到新标签）、`model/*.go` 注释。
本地用 brew 装的 Go 直接 `go run ./cmd/server/main.go` 跑后端；Docker 镜像在改动定稿后再构建一次。

后续开口子（先例都记在「进度」里对应批次）：内容类型白名单加 `social`、
`PATCH /api/feeds/:id/url`、`POST /api/feeds/refresh` 批量、订阅级 AI 覆盖、
**过滤规则（第六批）**：迁移 21 + `/api/filters/*` + `POST /api/entries/:id/unmute`。
判断标准不变：只动必要的一处、不改既有行为语义、把理由写进 IDEA.md。

## 边界（明确不做）

- 不改 Go 后端业务逻辑（若前端确实缺字段，另行讨论）。
- 不做「保存到第三方服务」（Nextflux 里那是 Miniflux 集成专属，Gist 后端无对应物）。
- 不引入 Nextflux 的播客/视频播放器（Gist 无对应数据源；需要再另开）。
- 不分发、不开源（Gist 是 GPL-2.0，本机自用无分发义务）。
- 不跟进 Gist 上游更新。

## 文档地图（各文件只放自己该放的）

| 文件 | 放什么 |
|---|---|
| `todo.md` | **唯一任务清单**：待办逐项勾选、已完成一行索引、细节指向 docs/ |
| `IDEA.md`（本文件） | 为什么做 / 需求清单 / 已拍板决策 / 边界 —— 不记进度 |
| `.hermes.md` | 工作铁律（动画样式走 HeroUI + Nextflux、列任务勾任务、全部实测、说看就看、违反即验收不合格） |
| `AGENTS.md` | 同一套规则的**可移植版**（给 Codex / Claude Code 等其他 agent 工具） |
| `docs/变更记录.md` | 各批次做了什么 + 实测证据（流水账） |
| `docs/移植笔记.md` | 技术细节、踩过的坑、本机怎么跑 |
| `docs/自动化-过滤规则.md` | 过滤规则（自动化）模块：设计决策 + 实现 + 验证 + 待办 |
| `docs/调研-2026-09-16.md` | 最初的仓库调研与选型 |
| `docs/archive/` | 已合并/被取代的历史文档（只读留档） |
| `app/AGENTS.md` | Gist 自身的前后端代码规范（写代码时同时遵守） |

## 本机怎么跑

见 `docs/移植笔记.md` 的「本机怎么跑起来」；后端 :8080（容器或 `go run`），前端 :5173。
并行开工时用 :8082 + 自己的库副本（见 `.hermes.md` 的协作约定）。
