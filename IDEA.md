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
- [x] 2026-09-16 侧栏底部账户栏（头像 + 用户名 + 分隔线），顶部只留 logo/名称/添加订阅
- [x] 2026-09-16 下拉与右键菜单统一：rounded-xl 圆角 + 主题化柔影（`var(--shadow-custom-md)`）+ 玻璃底
- [x] 2026-09-16 修 bug：批量改色时漏 `var()` 的 `color-mix` 声明（20 处，静默失效）+ TSX 里残余的 `hsl(var(--…))`
- [x] 2026-09-16 底部筛选胶囊（星标 / 未读 / 全部，接后端 starredOnly/unreadOnly，ego 实测三态）
- [x] 2026-09-16 键盘快捷键 j/k/m/s/v/Esc（+10 例单测 + ego 实测）；顺手修掉 EntryContent
      「打开即已读」把 m 标回已读的 bug
- [x] 2026-09-16 快捷键补齐：g 阅读模式、r 刷新、? 帮助弹窗（+5 例单测 + ego 实测）；帮助弹窗在
      侧栏账户菜单里也有入口
- [x] 2026-09-16 外观设置「阅读与列表」：列表图片 无/小/大、摘要行数、正文字体/字号/行高
      （存本机 UI 设置；+2 例单测 + ego 实测）
- [x] 2026-09-16 **社交媒体视图（第四类内容）**：与 文章 / 图片 / 通知 并列的独立视图（Folo 的标签页做法）
      - 侧栏切换器加第 4 个标签（SocialIcon + 未读数），路由 `?type=social`
      - 该视图的条目按 **时间线** 渲染：来源行（头像式 favicon + 源名 + 时间）→ 标题 → 正文直接铺开
        （视口内才渲染，长文 26rem 限高 + 渐隐「点开在阅读区查看全文」）
      - 正文开头与标题重复时自动去掉（多数源如此），失败则原样渲染
      - 后端：内容类型白名单加入 `social`（Go 侧 6 处 + 设置默认列表；老实例读取时自动补上）
      - **布局照 Folo 源码**（`references/folo`，稀疏检出）：`FeedViewType.SocialMedia` 带 `wideMode: true`
        → `useShowEntryDetailsColumn` 为 false → 两栏；`showEntryContentOnLeft` 为 true → 内容在主列内替换
      - 按视图设置（设置 → 外观 → 按视图设置）：滚动标已读（跟随通用/开/关）、缺全文时自动抓取（仅社交媒体）
      - 缺全文时自动抓取：条目进入视口且正文 < 400 字时调 fetch-readable，已抓过的条目不重复抓
      - 单测：stripDuplicatedTitle 6 例、按视图设置 3 例、侧栏快捷键 8 例
- [x] 2026-09-16 **侧栏快捷键**：n / p 上下订阅（循环）、x 展开折叠所在分组、Shift+N 添加订阅
- [x] 2026-09-16 动效细节：卡片涟漪（m3-ripple，Nextflux 同款参数）、已读卡片降透明度、
      主按钮内高光 + 描边、tooltip 胶囊、折叠缓动 ease-out

- [x] 2026-09-16 **细节对齐 Nextflux**：m3-ripple 涟漪、已读卡片降透明度、主按钮内高光、
      tooltip 胶囊、折叠缓动 ease-out
- [ ] 细节补齐：侧栏 hover/选中过渡、骨架屏 shimmer 对齐、图片画廊手势
- [ ] 侧栏分组层级微调（文件夹分组与未分组订阅的节奏）
- [ ] 快捷键再补：p/n 上下订阅源、x 展开分类、Shift+N 加订阅
- [ ] 外观设置补：动效开关（减少动态效果）、界面字号
- [ ] 移动端与 PWA 回归
- [ ] 本机 Docker 部署验收（NAS 待定）
