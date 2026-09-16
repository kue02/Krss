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
      - 条目按 Folo 的 SocialMediaItem 重做：32px 源图标在左 + 作者行 + 纯文字正文（图片抽成 112px 缩略图行）
        + 300px 折叠（遮罩渐隐 + 显示更多，对应 Folo 的 CollapsedSocialMediaItem）
      - 标题去重：源的标题常是「正文掐掉换行/带省略号截断」的版本，是正文开头就不单独渲染标题
      - 单测：stripDuplicatedTitle 9 例、stripContentImages 4 例、按视图设置 3 例、侧栏快捷键 8 例
- [x] 2026-09-16 **侧栏快捷键**：n / p 上下订阅（循环）、x 展开折叠所在分组、Shift+N 添加订阅
- [x] 2026-09-16 动效细节：卡片涟漪（m3-ripple，Nextflux 同款参数）、已读卡片降透明度、
      主按钮内高光 + 描边、tooltip 胶囊、折叠缓动 ease-out
- [x] 2026-09-16 列表骨架屏按卡片真实结构重写；缩略图加载前脉动、加载后淡入
- [x] 2026-09-16 细节收尾（第 3 批）：
      - 阅读区进场动效（200ms 淡入 + 4px 上浮）；「减少动态效果」同时管住 CSS 与 framer-motion（MotionConfig）
      - 列表滚动后右上角「序号 + 回到顶部」浮标（对齐 Nextflux 的 Indicator）
      - 侧栏订阅行/分组行/内容类型切换器补涟漪；分段控件滑块改用 --segment 令牌 + shadow-nf-sm
      - 已读条目不再双重压暗（标题恒为前景色，只用字重 + 0.78 不透明度）
      - PWA theme-color 跟随配色主题（light/stone #E3E1DE、leaf #DFE7E1、dark/nord-dark #242933）
      - 空状态/阅读区占位统一为「图标 size-16 + 文案 + opacity-60」（对齐 Nextflux 的 EmptyPlaceholder）
      - 侧栏账户按钮补键盘焦点环；侧栏过渡统一 200ms
- [ ] 本机 Docker 打包部署（用户已明确：暂不管，先磨细节）

- [x] 2026-09-16 **细节对齐 Nextflux**：m3-ripple 涟漪、已读卡片降透明度、主按钮内高光、
      tooltip 胶囊、折叠缓动 ease-out
- [x] 2026-09-16 细节补齐：侧栏 hover/选中过渡、骨架屏 shimmer 对齐、图片画廊手势（含缩放层）
- [x] 2026-09-16 侧栏分组层级微调（分组之间 6px、组标题下 2px，整列不再是一条连续列表）
- [x] 2026-09-16 快捷键再补：p/n 上下订阅源、x 展开分类、Shift+N 加订阅
- [x] 2026-09-16 外观设置补「减少动态效果」；界面字号仍是待定项（见文末待拍板）
- [ ] 移动端与 PWA 回归
- [ ] 本机 Docker 部署验收（NAS 待定；容器镜像是旧的，收尾要重新 build）

### 2026-09-16 清单批次（用户给的 15 项，1–14 完成，15 单列）

- [x] **1 缺全文时自动抓取**：实测文章源（少数派）摘要 104 字 → 抓回 3357 字全文，有用；
      社交源（X）抓回的是未登录落地页（`See what's happening…` / `Log in / Sign up`），比摘要更差。
      → 改为**只在文章类生效**，并新增 `lib/readable-quality` 做垃圾识别（登录墙/付费墙/过短一律丢弃）。
      另清掉测试期间写进库的 9 条污染 `readableContent`（备份 `data/gist.db.bak-readable`）
- [x] **2 复制 Feed 地址**：侧栏订阅右键菜单（FeedItem 新增 feedUrl）
- [x] **3 RSSHub 实例适配**：设置→通用新增「RSSHub 实例」（地址 + ACCESS_KEY）；
      `lib/rsshub`（9 例单测）负责改写（保留路径/查询、写入或清掉 key、支持实例带路径前缀）；
      可预览将被改写的现有订阅（逐条 before→after）并一键迁移；添加订阅时自动换到该实例。
      后端补 `PATCH /api/feeds/:id/url`（实测改地址 200 且可复原）。正好对上自建 `rsshub.wxhdj.xyz`
- [x] **4 AI 自动探测模型**：`POST /api/settings/ai/models`（OpenAI/兼容 `GET {base}/models`、Anthropic `/v1/models`）；
      设置页「探测模型」点选即填。实测返回真实模型列表
- [x] **5 订阅级自动翻译/摘要**：迁移 19 加 `auto_translate`/`auto_summary`（NULL=跟随全局）+
      `PATCH /api/feeds/:id/ai`；编辑订阅源里两组「跟随全局/开/关」，列表与阅读区取值改为 `feed 覆盖 ?? 全局`。
      实测 PATCH 200、读回一致
- [x] **6 列表头刷新按钮**：按当前范围刷新（单源/文件夹内所有源/该内容类型的所有源/星标=全部）；
      后端 `POST /api/feeds/refresh` 支持 `{feedIds:[...]}`。实测单源刷新 691ms 返回 204（对比全部刷新的分钟级）；
      同步接口没即时反馈的问题也修了（点击即提示「正在刷新 N 个订阅」）
- [x] **7 文件夹右键重命名**：`RenameFolderDialog` + `useUpdateFolder`
- [x] **8 添加订阅选视图 + 预览**：四个视图胶囊 + `ViewPreviewMock` 静态小样（随选择切换）
- [x] **9 订阅真图标**：根因是 dev server 只代理了 `/api`，`/icons/*` 落到 SPA 兜底返回 HTML，
      `<img>` 必然失败退回默认图标 → vite 增加 `/icons` 代理。实测侧栏 9/9 图标加载成功
- [x] **10 条目复制链接**：卡片底部 / 社交条目底部 / 悬停操作条三处；配合新增的全局提示条
- [x] **11 改名 krss + 新图标**：自绘图标（圆角渐变底 + k 字形 + RSS 弧线），几何与像素双重自检后
      生成 512/192/180/64/32 + maskable + ico + logo.svg；标题/manifest/界面文案全部 Gist→krss
- [x] **12 omlx「链接重置」**：实证容器内 `127.0.0.1:8000` 连不上（容器自己的 loopback）、
      `host.docker.internal:8000` 可达 → provider 层加 `normalizeBaseURL`（仅容器内替换 loopback），
      AI 设置页给提示。8 例单测
- [x] **13 阅读栏加载原站**：`OriginalSiteView`（iframe + 常驻「新窗口打开」出口），头部地球按钮切换。
      实测 iframe 加载 sspai 文章页 810×824
- [x] **14 AI 多提供商**：`ai.providers` / `ai.active_provider_id` 存储，列表可增删、改名、切换「当前使用」，
      平铺字段始终等于当前那份（AI 服务读取路径零改动）
- [x] **15 用 ego 打开 Nextflux 逐项校对样式与动效**（参照物是用户 NAS 上的实例 `http://192.0.2.1:3100/`，
      Ego 已登录）。做法：在两边量**同一批元素的 computed style** 再对齐，不靠肉眼。已对齐：卡片内边距 8px、
      圆角 10px(≈9.6)、标题 16px/600/24px、源名 12px/700、元信息 12px、摘要 14px、源图标 20px、阅读正文默认 16px/1.8；
      一致项：侧栏 256px、列表头按钮 32×32 圆形、卡片 hover `all .2s` + 涟漪参数、四档阴影令牌。
      刻意保留：已读态（Nextflux muted+opacity-50 对比度仅 ≈2.4）、社交正文（对齐 Folo 的 14px/1.625）。
      未实现（中等宽度才触发）：`.article-list-shifted/.sidebar-shifted` 0.5s 位移+变暗、设置面板 300ms 滑入 + blur(3px)。
      对照表与取舍写在 `docs/移植笔记.md`

- [x] 2026-09-16 **第七批：按区域与 Nextflux 线上实例对齐**（用户反馈「只对到列表卡片，正文栏大圆角+高度差远了，还有条目/feed/设置/我的/弹框」）
      - 正文栏：圆角 24→13px、上下右留白→8px（面板 y=8/h=884/bottom=892/right=1432 逐值相同）、去掉柔影、
        文章内边距 20/20/80、h1 36px/700→25.6px/600、工具条 blur(8px)、中栏默认宽 356→336
      - 侧栏：行字号 13→14px、圆角 8→10px、图标→16px、logo→32px、账户栏改成 239×40 圆角 19px 按钮（去顶部分隔线）
      - 设置：分组卡片去边框改 shadow-custom、行高 48px、标签 14px、分段控件改胶囊
      - 弹框：按 HeroUI 规格（头部 p-4 / 内容 px-4 pb-4 / 底部 border-t p-4）、个人资料弹框收窄到 520px
      - 动效：折叠动画本就与 Nextflux 的 0.2s ease-out 一致；菜单 160ms scale+fade
- [x] 2026-09-16 **滚动已读语义做成可选**：按视图可切「滚出顶部（默认）/ 看到即已读（Folo）」，
      onVisible 需停留 600ms、划走取消；4 个单测覆盖两种语义

### 2026-09-16 第二批清单（用户给的 8 项，1–7 完成，8 = 终检）

- [x] **1 刷新按钮发灰 + 转圈动效**：去掉 `text-muted-foreground` 与 `disabled:opacity-60`（发灰的两个来源）；
      刷新中换成「持续转动的弧 + 圈内显示还剩几个源」，每刷完一个减一。
      后端 `refreshService` 记录本次刷新的 total/completed（`GET /api/feeds/refresh` 仅在刷新中返回），
      前端 400ms 轮询。实测：3 个源 3→2→1→0，结束后图标复原；按钮颜色与旁边两个按钮一致。+6 例单测
- [x] **2 添加订阅选视图 + 真实内容试看**（重做 #8）：后端 `/api/feeds/preview` 一并返回前 4 条真实条目
      （复用 `itemToEntry`、正文截 2000 字、不落库）；前端把视图胶囊搬进订阅卡片底部，
      下方用**该视图真正的渲染组件**画真实条目（文章/通知=EntryListItem、图片=PictureItem 三列网格、
      社交媒体=时间线），整块 `pointer-events-none` 防误触。删掉静态色块示意（ViewPreviewMock）。
      实测：四视图切换正常、图片视图 3 列 4 图（iplaysoft 源 4/4 加载成功）。+5 例前端单测 +7 例 Go 单测
- [x] **3 RSSHub 实例设置记不住**：根因不在前端而在 handler —— `generalSettingsRequest/Response`
      压根没有 `rsshubBaseUrl`/`rsshubAccessKey` 两个字段，PUT 丢掉、GET 不回。补上两个 DTO 并接上读写。
      实测：PUT→GET 往返一致、DB 落盘；整页重载后打开设置，两个输入框自动填回且「保存」正确置灰。+1 例 Go 单测
- [x] **4 两栏视图（社交媒体/图片/添加订阅）面板贴边突兀**：三栏时正文面板左边紧邻列表列（与页面同色，
      看不出来），两栏时左边直接是深色侧栏，圆角 + 边框硬贴上去。现在 `hideList` 时补 8px 左边距，
      四边一致浮起（实测 innerX 256→264，右/下仍 8px；三栏不受影响）
- [x] **5 侧栏订阅行图标与名称没对齐**：订阅行的图标/名称包在一个**没有 gap** 的 flex 里（分组行/星标行
      都是行级 gap-2），于是贴在一起；无 favicon 时的占位图标还是 18px（盒子 16px），会让该行名称偏移。
      已统一为 8px 间距 + 16px 占位图标。实测：订阅行 labelX 14→38，与分组行完全对齐
- [x] **6 正文右侧悬浮目录**：新增 `EntryToc`，收集「文章标题 + `.prose` 内小标题」（界面自带的 AI 摘要块不算），
      右缘 24px 隐形窄带触发，悬浮才展开玻璃底面板；点标题平滑滚动并高亮当前小节。
      正文是嵌套滚动容器，跳转用容器自身算 scrollTop；标题元素查表而非 CSS.escape。+5 例单测
- [x] **7 设置项与右键菜单归类排序**：标签顺序改为 外观 → 订阅 → 文件夹 → 通用 → AI → 网络 → 高级 → 数据控制
      （顺序抽成 `SETTINGS_TAB_ORDER` 一份常量，桌面侧栏与移动端下拉共用）；
      订阅右键菜单里「复制 Feed 地址」挪到「更改类型」之后，订阅/文件夹的「删除」都单独成组（前加分隔线）
- [x] **8 终检**：前端 56 文件 561 例、后端 `go vet` + 全部包测试、`bun run build`（生产构建）全绿；
      页面运行时错误 0；swagger 按 swag 重新生成。**未做**：移动端与 PWA 回归、Docker 部署（用户明确暂缓）

### 待拍板（等用户）

- ~~Folo 滚动已读的语义差异~~ → 已解决：做成按视图可选（滚出顶部 / 看到即已读），默认滚出顶部
- 外观设置是否补「界面字号」？（动效开关已补；阅读正文字号本就可在「外观」里调，默认已改为 16px）

