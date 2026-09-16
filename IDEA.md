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
- 中栏宽度由 ~930px 收窄到 ~420–580px（响应式断点需重算）。
- 正文区改**浮层圆角面板**（留 16px 外边距）+ 独立圆形按钮工具条。
- 侧栏：分组折叠、未读计数、选中胶囊态、底部账户栏。

### 二、功能移植（Nextflux 有、Gist 没有）
- 键盘快捷键 18 项 + 快捷键帮助弹窗。
- 外观/排版设置：字体族、字号、行高、标题/正文预览行数、卡片图片尺寸、动效开关。
- 多主题切换（亮/暗各选一套）。
- 中栏底部 Starred / Unread / All 胶囊筛选（Gist 后端已支持 `unreadOnly` / `starredOnly` / `hasThumbnail`，可直接接）。
- 图片画廊手势（Gist 已有 Lightbox，补缩放手势）。

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

## 边界（明确不做）

- 不改 Go 后端业务逻辑（若前端确实缺字段，另行讨论）。
- 不做「保存到第三方服务」（Nextflux 里那是 Miniflux 集成专属，Gist 后端无对应物）。
- 不引入 Nextflux 的播客/视频播放器（Gist 无对应数据源；需要再另开）。
- 不分发、不开源（Gist 是 GPL-2.0，本机自用无分发义务）。
- 不跟进 Gist 上游更新。

## 进度

- [x] 2026-09-16 调研两仓库（源码精读 + 官方截图比对），定基座与路线 → `docs/调研-2026-09-16.md`
- [x] 2026-09-16 建项目目录、写 IDEA.md、注册 Hermes Project
- [x] 2026-09-16 环境跑通：后端 `ghcr.io/9bingyin/gist:develop` 容器（:8080，数据在 `~/Documents/Docker/gist-nextflux/data`）+ 前端 `bun run dev`（:5173）；dev 账号 kue / REDACTED
- [x] 2026-09-16 HeroUI v3.2.5 引入 + 设计 token 层（Gist 调色板整体映射到 HeroUI token）→ `src/styles/nextflux-theme.css`
- [x] 2026-09-16 5 套主题接进应用（亮：light/stone/leaf；暗：dark/nord-dark，设置→外观里有色卡）→ `src/hooks/useTheme.ts`
- [x] 2026-09-16 中栏文章列表卡片化（缩略图 / 来源行 / 大标题 / 摘要 / 阅读时长 / 选中浮起）
- [x] 2026-09-16 侧栏：品牌区、条目胶囊行（更高行、20px 圆角 favicon + 浅投影）、分组标题与未读计数、内容类型改分段胶囊（选中=浮起卡片+强调色图标）
- [x] 2026-09-16 正文区改浮层圆角面板（外边距 17/16/14 + 24px 圆角 + 柔影 + 细边框；移动端不加面板）
- [x] 2026-09-16 正文工具条 + 中栏列表头改圆形浮动按钮语言（含开启态浅底、active:scale-95）
- [x] 2026-09-16 建 Git 仓库（基线提交 + 首轮改造提交），见 `docs/移植笔记.md` 的 Git 约定
- [x] 2026-09-16 实测三栏比例已接近 Nextflux（Gist 256/356/自适应 vs Nextflux 307/346），栏宽暂按原默认值不动，交给拖拽
- [ ] 侧栏细化：分组层级、订阅源 hover/选中态、底部账户栏（ProfileButton 仍偏旧）
- [ ] 功能移植（快捷键 / 外观设置 / 底部胶囊筛选 / 字体设置）
- [ ] 移动端与 PWA 回归
- [ ] 本机 Docker 部署验收（NAS 待定）
