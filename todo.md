# todo —— 唯一任务清单

> **规矩**：新功能 / 修复先在这里列出来再动手；**做一项勾一项**；勾之前必须有**实测证据**（接口真打、浏览器真点）。
> 本文件只回答"要不要做、做到哪、证据在哪"；细节进 `docs/` 对应模块文档，技术坑进 `docs/移植笔记.md`。
> 历史流水与实测数字：`docs/变更记录.md`。

## 0. 立刻要做（已拍板 / 收尾）

- [ ] **搜索排除静音条目**：`entry_repository.Search` 的 SQL 补 `muted = 0` + 一条回归测试
      （2026-09-17 用户拍板：静音必搜不到，与列表默认隐藏一致）
- [ ] **后端补校验**：`ValidateFilterParams` 拦掉 `mute + keepOnly`（UI 已互斥，API 未拦）
- [ ] **文档收尾**：`docs/变更记录.md` 过滤一节里那条"已静音视图标题"陈旧条目（其实已修，代码在 `EntryList.tsx`）；
      并把 2026-09-17 遗留在工作区的 `IDEA.md` 改动提交
- [ ] **残留清理**：`~/Documents/Docker/gist-nextflux/data-filter`（20M 测试库副本）—— 删否
- [ ] （可选）`vite.config.ts` dev 代理硬编码 `:8080` 改成环境变量 —— 只在并行开工时才需要

## 0.5 第九批：界面细调 + 自动化重构（2026-09-17 用户清单，按原序号）

> 这一批的总要求：**界面、动效一律走 HeroUI v3（https://heroui.com/）与 Nextflux 既有实现**，取值量 computed style；
> Nextflux 没有的形态（自动化页）用 HeroUI 组件自行组织，但必须沿用项目已有的视觉语汇。
> Nextflux 源码要点：代码高亮用 **shiki**（`src/components/ArticleView/components/CodeBlock.jsx`）；
> 账户菜单 `FeedList/components/ProfileButton.jsx`；feed/folder 右键 `FeedList/components/FeedItem.jsx` + `FeedsGroupContent.jsx`；
> 通用菜单 `ui/ContextMenu.jsx`。**Nextflux 没有自动化页**，那部分没有可抄的形态。

- [x] **1. 搜索结果的来源标签 / 头像**：条目行末尾补「来源名」标签（细边小贴纸），订阅行前补 favicon 头像
      —— 新增共享组件 `src/components/ui/feed-avatar.tsx`（有 favicon 用 favicon、失败/缺失退成通用 RSS 图标，
      并统一带上 width/height + lazy + async 解码）；`FeedIcon` 补 `style` 支持显式尺寸
      —— 实测（ego-browser 真点）：文章档每行 tag = `Twitter @陈桂林` / `折腾啥 - Telegram Channel` 等；
      订阅档每行 `<img src="/icons/github.com.ico">` 等
      —— 记一笔：`/icons/${iconPath}` + 失败兜底这套逻辑在项目里已散落 5 处，新代码统一走 `FeedAvatar`，老代码按需迁移
- [x] **2. 菜单对齐 Nextflux**
  - [x] 账户（Kue）单击弹出框：**改用 HeroUI v3 `Dropdown`**（照 Nextflux `ProfileButton` 的结构：Popover placement="top left" + Menu onAction + Item id/textValue + lucide 图标），**已去掉「已加星标」**
        —— 实测：触发器类名 `dropdown__trigger`、菜单 4 项（个人资料/设置/快捷键/退出登录）、宽 187px、无「已加星标」（ego-browser 真点）
  - [x] **连带修**：`StarredItem` 组件写了但**全项目从未渲染**——账户菜单是星标唯一入口，删掉会让功能失联；
        已按 Nextflux 的位置把它挂到侧栏导航顶部（实测：点击后 `data-active=true`）
  - [x] feed / 文件夹右键菜单：**都加了标题行**（favicon/文件夹图标 + 名称，对齐 Nextflux 右键菜单顶部那行）
        + **每一项都带图标**（lucide：刷新/编辑/移动/更改类型/复制地址/删除，自动化入口用项目自己的 BoltIcon）；
        危险项仍单独分组、红色
        —— 实测（ego-browser 真点右键）：订阅「少数派」菜单标题行含 favicon，7 项 **7/7** 带图标；
        文件夹「见解」「Audios」菜单标题行含图标，4 项 **4/4** 带图标
        —— 记一笔：条目卡片的右键菜单（豁免这类内容 / 按此条新建规则）没有图标，用户本轮只点了 feed 与文件夹
- [x] **3. Krss 左侧加号菜单**：已改为「添加订阅源 / 新建自动化 / 新增分类」，**移除「导入 OPML」**（连带删掉隐藏 file input 与导入逻辑）
      实测：菜单三项且无 OPML；点「新建自动化」直接开出「新建规则」抽屉（ego-browser 真点）
- [x] **4. 设置 → 自动化页重构**：改成纯管理页 —— 顶部工具条（用文字建规则 / + 新建规则）、「已静音条目」块、
      **规则段**（一条两行：开关+名称+范围+状态 / 条件 → 动作 + 命中·最近命中）、**视图段**（带数量与新建入口）；
      8 列表格删了（`tableStillThere: 0`），行内只剩开关与 ↑↓，编辑/命中记录/回溯历史/撤销影响/删除 收进行尾「⋯」菜单
      （实测菜单 5 项）；执行失败在行内红字 + tooltip
      —— 弹窗全部换 HeroUI（Modal / AlertDialog），控制台那条 Radix「Missing Description」告警随之消失；
      实测：命中数点开是 HeroUI `modal__dialog--md`，含条目标题 / 动作 / 来源 / 时间
- [x] **6. 自动化编辑器外壳（方案 A）**：桌面 HeroUI `Drawer` 右侧 620px；移动端底部全屏 Sheet；共用同一个 `FilterEditor`
      —— 实测（ego-browser 真点）：桌面 `drawer__content--right` 右贴边（right=视口宽）宽 620；
      抽屉开着把视口收窄到 390×844 后**实时**切成 `drawer__content--bottom`，盒子 390×844 满屏
      —— 踩到的坑：HeroUI 的 drawer content 默认 left/right 齐设（过约束），只给宽度会让浏览器按 left 解、抽屉跑到左边（实测 x=0），
      必须显式 `left-auto right-0`
- [x] **5. 中栏筛选胶囊去掉「已静音」**：只剩星标 / 未读 / 全部三态；回看入口搬进 设置 → 自动化
      （「已静音条目 · 查看已静音」一键切视图 + 关设置）
      —— 实测：自动化页有该块、点击后设置关闭 + 列表标题变「已静音」+ 胶囊保持三态
      —— **顺手抓到并修掉一个真 bug**：该入口原先带 `contentType`，用户在「文章」标签下点会看到一片空
      （实测接口：`mutedOnly=true` 返回 2 条，加 `contentType=article` 返回 0 条 —— 静音条目属于别的内容类型）；
      回看态现在不带 contentType，实测变成 2 张卡；补了回归测试
- [ ] **6. 自动化编辑器（右侧抽屉）重构**：桌面保留抽屉、移动端改全屏 Sheet（考虑移动端输入与滚动体验）
- [x] **7. 正文代码块**：适配 + 语法高亮 + 行号
      - **适配（真问题）**：文章里的代码块是 WordPress/WP-Syntax 风格 `<pre class="brush: bash">`，**没有 `<code>` 子元素**，
        而高亮 hook 只找 `pre code` → 这类块被整个跳过（既不高亮也没行号）。现在：裸 `pre` 先补 `<code>` 壳再走同一套流程，
        语言从 `brush: x` / `language-x` / `lang-x` / `data-language` 里认
      - **外观**：`pre.shiki` 原先被设成透明底（看着就是一段等宽文字），改成「块本体用主题 shiki 底、span 保持透明」；
        补边框 + 10px 圆角 + 内边距；窄屏横向滚动、宽屏折行（与 Nextflux 的 `pre code` 表现一致）
      - **行号**：CSS 计数器画（对齐 Nextflux 的 `.line-numbers`，不额外包 DOM），行号不可被选中；
        开关在 外观 → 阅读 → **代码块行号**（`showLineNumbers`，默认**开** —— Nextflux 默认关，但用户明确要行号）
      - 实测（ego-browser + 截图逐项核对）：`brush: bash` 被识别 → 15 行、29 个着色 token、`data-shiki-highlighted=true`、
        头部 BASH + 复制按钮、`overflowPx=0`、行号 1–15 可见、灰底圆角边框
- [x] **8. 自动化顺序改拖动**：规则行左侧加**拖动把手**（`framer-motion` 的 `Reorder.Group` + `dragListener={false}` + 每行自己的
      `useDragControls`，避免开关/名称/命中数跟拖动抢事件）；拖动后按新顺序重编号落库，**只提交位置真的变了的那些**；
      行内不再摆 ↑↓，「上移 / 下移」降级进行尾「⋯」菜单（键盘用户与不想拖的人仍可用；disabled 用 `isDisabled` 置灰）
      —— 实测（ego-browser 真拖 + 查库）：拖动前 DOM 顺序 `[test, ZZ-临时]` → 拖动后 `[ZZ-临时, test]`，
      **DB 同步变成 `ZZ-临时=0 / test=1`**（真落库，不只是视觉位移）；临时规则已删、你的库只多了一条被拖动的 position 记录
      —— 注：还原 position 时发现你线上**旧二进制**的 `PATCH /api/filters/:id` 一律回 `400 invalid request`（旧版 DTO 与新版不同），
      只有一条规则时 position 只是排序键、无行为影响，重启容器上新版后可归位
- [ ] **9. 细调与性能**（贯穿全批）
  - [x] 下拉框换 HeroUI 组件：新增 `src/components/ui/select.tsx`（HeroUI v3 `Select` + `ListBox`，react-aria 引擎、自带弹层动效/键盘/触摸），
        **设置页 4 处已换**（AI: provider / 摘要语言 / 翻译通道；设置弹窗移动端 tab 选择器）
        —— 实测：`select__trigger` → 弹层 `data-slot="list-box"` 带 3 个 option（ego-browser 真点）
  - [x] `FilterEditor` 里剩下的 4 处原生 `<select>` 已随第 4/6 项重构换掉（编辑器的范围/字段/操作符）
        —— 实测：全仓 `<select>` 归零（仅剩 HeroUI Select 内部用于表单语义的隐藏原生元素）；顺手删掉只有它用的 `selectClass`
  - [x] **性能基线实测（改动前取证）**：`language-detect-*.js` **454 KB(gzip)**（全站最大，懒加载但列表判定语言即拉起）；
        条目列表**无虚拟化**（只有社交流用的 `@virtuoso.dev/masonry`）；`EntryListItem` **无 `memo()`** → 列表状态一变就重渲染所有卡片；
        `framer-motion` 与 `motion` 12.x **双份依赖**；`dist/assets` 里已有 shiki 语言分块（cpp 46KB、ts/tsx/jsx 各 16KB）
  - [x] **动画/动效流畅度（第一轮，已实测）**：卡片 `memo` 化 + 选中回调身份稳定（根因：`selectEntry` 来自 wouter，点条目必换路由 → 50 张卡全量重渲）
        —— 实测点一条 **100 → 2 次**卡片渲染、长任务 72ms → 0；图片补 `decoding="async"`/宽高/懒加载
        —— 实测 lazy 31→231、async 0→231、缺宽高 234→34、LayoutCount 237→126、LayoutDuration 52→16ms（提交 `92adf94`）
  - [ ] **列表虚拟化（下一个大动作）**：实测 200 张卡挂在 DOM（3271 节点），25 步滚动主线程忙 **2837ms**，其中 JS 800ms /
        792 次样式重算 491ms —— 屏外排版已用 `content-visibility` 试过**无收益**（67ms/帧 → 基本不变，已撤），
        残留开销来自「每张卡都真在 React 树里」，只有虚拟化能削。需按「文档滚动 / 元素滚动 + 社交媒体时间线 + 滚动位置还原」分别设计
  - [ ] `language-detect-*.js` **454 KB(gzip)**（全站最大块，懒加载但列表判定语言即拉起）：当前只在开启翻译时走，是否还要压/降级待定
  - [x] 双份动画依赖（`framer-motion` + `motion`）已清成一份 —— **但实测包体没变**（打包器本来就去重），如实记为「清依赖」而非性能收益
  - [ ] `notify` 动作（Bark）一并做掉（见上一节 P2）



## 0.6 Bug 队列（2026-09-17 用户报，先记后修）

- [x] **BUG-1 社交媒体视图：关掉详情后列表会位移（像是自己向上滚了）** —— 已修，实测位移 0
      根因：桌面社交视图里「详情 or 列表」是同一个插槽的二选一（`selectedEntryId ? <详情/> : <EntryList/>`），
      点开条目会**整块卸载** EntryList，关闭时重新挂载，滚动位置只能靠模块级 map 还原 → 看起来就是「自己往上滚了」。
      移动端那段代码反而写对了（注释写着「列表保持挂载以保留状态」）。
      修法：与移动端对齐 —— 列表常驻，详情盖在上面（`absolute` + `inert` + `aria-hidden`），列表传 `isActive={!selectedEntryId}`
      实测：开/关详情前后 卡片数 50→50、首个可见条目 id 相同、`top` 148→148（位移 **0**）
- [x] **BUG-2 滚动时条目跳动（向下滑再往回滑）** —— 两条机制都已处理
      - 机制一（已修）：已读态把标题从 `font-semibold` 切成 `font-medium`，**字重一变换行数就可能变**（1 行 ↔ 2 行），
        卡片高度跟着变，滚动标记已读就会让列表跳一下。Nextflux 的 `ArticleCard` 是「字体恒 semibold、只用颜色区分读态」，
        已对齐；补了回归测试（断言两种状态类名都含 `font-semibold`、只有颜色类不同）
      - 机制二（已修）：社交卡片正文是 `inView` 门控（进视口前挂载、一挂载最多撑开 300px）。
        向下滚时新卡在**下方**挂载不影响可见内容，向上滚时卡片在**上方**挂载会把可见内容整体推下去 —— 正是「往下滑再往上滑就跳」。
        改成非对称 margin `2000px 0px 1000px 0px`，让上方提前挂载。
        **诚实标注**：这条是机制性修复，本轮自动化脚本**没能复现**跳动（能复现的前提恰好是 BUG-1 的「列表被卸载重挂」），
        等你实机再验；若仍有跳动，下一刀就上「移除卡片时按高度补偿滚动」

## 0.7 第十批（2026-09-17 用户清单，14 项）

> **验收口（用户 2026-09-17 明确）**：前端只跑 `http://localhost:5173`（`app/frontend` 的 `bun run dev`，`/api` 反代到 :8080）；
> 后端 :8080 走**源码** `go run ./cmd/server/main.go`（改 Go 代码秒级重启，不必 build 镜像）。实测一律在 5173 上做。


> 用户原话逐条记录在下方；**凡是我前几轮改动引入的回归，优先修**（第 14、10、8 的透明文字/空白图标先查）。

- [x] **10-1 正文链接加外链小箭头**（2026-09-17）：`.entry-content .prose a[href^="http"]::after` 用 mask 画 lucide `arrow-up-right`（0.7em、opacity .45、hover .8、颜色跟文字）；
      排除图片链接（`:has(> img)`）与已标注项，标题链接在 `<h1>`（prose 之外）天然不中。
      实测：在位 CSS 测试（真实标记结构的合成链接）外链 `::after` content `""`／宽 **11.2px**／mask ✓，图片链接·相对链接·标注项一律 `content: none`；
      真实文章「城市漫步指南｜威海初秋」1 条外链 → **1 个箭头** ✓
- [x] **10-2 搜索结果补订阅图标 + 点订阅要选中侧栏**（2026-09-17）：
      ① 条目行前加订阅头像（`FeedAvatar iconPath size=20 rounded=circle`）；
      ② 点订阅结果改走 `selectFeed()`（原先裸 `navigate("/feed/<id>")` 会把 `?type=`/`?unread=` **丢掉**，视图被重置成「文章」）；
      ③ 订阅若躺在**折叠的分类**里，侧栏那条根本没渲染 → 选中态看不见，所以同时 `expandAll([分类名])` 展开它。
      实测：搜 Obsidian 的 3 条条目结果**每条前面都有 IMG 头像 20px**（leftOffset 12）；
      先真实点分类箭头折叠（`gist-category-state` = `{"资讯":false}`）→ 搜索点「小众软件」→ **状态变 `{"资讯":true}`（自动展开）**、`activeRows: ["小众软件"]`、URL = `/feed/…?type=article`（视图保住了）
- [x] **10-3 去掉界面语言的自动切换**（2026-09-17）：`components/i18n-provider.tsx` 不再读 `navigator.language`，只认 通用→语言 存的 `gist-lang`，没设过就固定 **zh**。
      实测：清掉 `gist-lang` 后 `html lang = zh-CN`、界面中文（注意：ego 浏览器本机 locale 也是 zh-CN，所以这条**不是**判定「不再跟随浏览器」的强证据；强证据是代码里已无 `navigator.language`）
- [x] **10-4 RSSHub 换链接导致订阅地址相同时：弹框确认覆盖并合并为一个源** —— 已完成
      「换到该实例」点应用时先逐条探预览 → 撞上弹 HeroUI AlertDialog（逐条列「旧链接（N 条/M 星标）→ 并入 新链接（X 条/Y 星标）」+ 另几条只换地址的说明）→「确认合并」逐条并入；
      **保留先存在的那条**（用户拍板），来源条目/星标/分类并过去后删来源；后端 PATCH 同时加了 409 兜底（带冲突订阅 id/title）。
      实测：副本库 :8099 真链路 —— PATCH 撞车 **409**（conflict.id 正确、A 地址未改）→ 预览 source 7 条/1 星标 · target 20 条/0 星标（与库一致）→
      合并 `{movedEntries:7,dedupedEntries:0}` → 查库 A 条目 0 / A 订阅 0 / B 条目 **27** / B 星标 1（跟随）；脚本 `~/Documents/test/gist-nextflux-e2e/verify-feed-merge.py`。
      单测：repo 2 + service 6 + handler 4 全过；`make test` 绿、lint 0、swagger 已重生成；前端 **617/617**、tsc 干净。
      `:8080` 已换新二进制（merge-preview 实测 200），用户库未被实验动过（79 订阅 / 2237 条）。
      **真机点过（ego-browser @5173）**：你库里正好有 2 条会撞车（Newlearner 0 条 → 已有 25 条；Twitter @歸藏 0 条 → 已有 10 条）——
      点「换到该实例（2）」→ 弹框出现且逐条显示「（0 条 / 0 星标）→ 并入 …（25 条 / 0 星标）」，按钮「取消 / 确认合并」；
      点「取消」→ 弹框关闭、设置面板仍可交互、**库内订阅数 79 与两条 URL 均未变**（有冲突时全部不写，只等你拍板）；控制台 0 错误。
- [x] **10-5 翻译选项文案**（2026-09-17）：zh/en 各改 3 条 —— 「跟随模型」「Google 翻译（免费）」「有道翻译（免费）」（原先括号里写了「用上面的提供商 / 无需 Key / 长文可能被限流」）
- [x] **10-6 去掉下拉框/按钮的蓝色选中边框（focus ring）**（2026-09-17）：默认主题 `--focus` 就是 HeroUI 的蓝色 accent，HeroUI 组件拿它画焦点环 →
      改成中性 `color-mix(in oklab, var(--foreground) 32%, transparent)`；顺带把**浏览器 UA 蓝框**（`outline: auto` → `rgb(0,95,204)`）也换成中性 `:focus-visible` 环。
      实测：全站扫「UA auto / rgb(0,95,204)」= **0 处**。
      **用户复看：后半「hover 没悬浮样式」已随 token 修复消失** ✓。
      **但前半换成了黑框**（用户截图：菜单第一项一圈近黑描边）→ 根因是我那条 `:focus-visible` 写成**未分层 CSS**，
      盖过了 HeroUI 在 `@layer components` 里给菜单项写的 `outline: none`（未分层 > 分层）。移进 `@layer base` 后：
      HeroUI 组件恢复无框（Nextflux 同款），我们手写控件仍有中性环。实测真实点开账户菜单：**4/4 项 `outline: none`**、视觉复核无描边 ✓
- [x] **10-7 Feed 右键菜单部分图标偏移 → 对齐**（2026-09-17）：根因是共享组件 `ui/context-menu.tsx` 的 `ContextMenuSubTrigger`
      写成 `h-[28px] px-2.5 py-1` 且**漏了 `gap-3`**，与普通项 `ContextMenuItem`（`min-h-9` + `gap-3`）不一致 → 子菜单项矮 8px、图标文字少 12px 间距。
      已统一（含圆角/hover 色）。实测订阅右键 **7/7** 项 h=36 · iconX=10 · iconCy=18 · textX=38 完全一致；文件夹右键 **4/4** 一致。
- [x] **10-8 图标与配色问题（回归）**：Kue 出现两个图标；两处图标空白（Kue 菜单「快捷键」右侧、新建规则右上关闭）；
      新建规则抽屉里**部分文字与输入内容变成透明**（与背景同色）；动作区「静音 / 未读 / 加星」等互斥项考虑合并成可变按钮
      - **已修（前三项同根因）**：项目 `@theme` 把 HeroUI 当**文字色**用的 `--color-muted`/`--color-accent` 改成了**底色**语义
        （`bg-muted`/`bg-accent` 全仓 97 处按底色用），于是 HeroUI 组件里 `color: var(--color-muted)` 解析成近白 → 抽屉正文/输入框/关闭图标/Kbd「?」/头像首字母全是白底白字。
        已按 HeroUI 语义修正 token，97 处底色用法改到 `bg-secondary`（值相同、视觉不变）。实测：抽屉正文与输入值 **0.9524 → 0.5517**、头像字母变蓝、关闭图标可见、Kbd 可读。
        「Kue 两个图标」= 触发按钮里**两个重复的 chevrons-up-down**（调用方与组件各画一个）→ DOM 实测 **2 → 1**。
      - **已完成后半（三态可变按钮）**：静音/已读/星标各一行 `SegmentedControl` 三态 —— 「不变 / 正向 / 反向」
        （共用项目已有的 Nextflux 分段令牌组件，并给它加了 `disabledValues`）；`keepOnly` 与「静音」互斥时该选项置灰并给提示文案。
        实测：抽屉里三行渲染为 静音[不变·静音·取消静音]、已读[不变·标为已读·标为未读]、星标[不变·加星·取消星标]；
        真实点击「取消静音」→ 静音自动落选（`静音:active → 取消静音:active`），再点「不变」两边清空 ✓；库里规则未变（没点保存）
- [x] **10-9 设置项重复与逻辑梳理**（2026-09-17，按你拍板的 4 条做）：
      ① **主题区合并成一块**：模式（跟随系统/浅色/深色）+ 亮色/暗色配色放进同一张卡片，说明「下面两栏是配色，用哪一栏由这里决定」；
      ② **已读相关收口**：通用 → 滚动时自动标为已读改成**三态**（关 / 开 / 按视图单独设），只有选「按视图单独设」，外观里 4 个视图的覆盖行才出现；
      ③ **判定联动**：总开关为「关」时，4 行「已读判定」整行置灰 + 注明「「滚动标已读」已关闭，判定不生效」；
      ④ 分类视图排序/隐藏仍留外观，侧栏那份只是切换入口，不动。
      新增 `hooks/useScrollReadSetting.ts` 作为唯一解析入口（mode + 按视图覆盖 + 后端布尔），`EntryList` 改用它；
      **存量数据按现状推导**（有任一视图非 `inherit` → perView，否则跟随后端布尔）→ 你的设置行为不变。
      实测：主题区同卡片含模式+两栏配色 ✓；通用三态 `开:active` ✓；切「关」→ 按视图无「跟随通用」行（`HAS_INHERIT_ROW: false`）、
      4 行判定 `aria-disabled` + 提示、**真实鼠标点「看到即已读」→ localStorage 未变（点不动）** ✓；
      切「按视图单独设」→ **4 行「跟随通用」出现** ✓；恢复「开」→ 后端 `general.mark_read_on_scroll` 仍为 `true`（行为未改）✓
      门禁：`bunx tsc -b` 干净、`bun run test` **609/609**（外观测试补 mode mock 与「关」联动用例）
- [x] **10-10 新建视图：预览不出来、保存不了** —— **已解决（不是代码 bug）**：:8080 上挂的是 **15:12 起的旧 `go run` 进程**（旧代码，库里 filters 连 `kind` 列都没有）。
      2026-09-17 22:17 已杀掉旧进程、用**当前源码**在 :8080 重启：预览 → **200**、建视图 → **201**、迁移 22/23 上库（filters 有 `kind`/`last_error`，entries 有 `auto_translate`/`auto_summary`）✓
      备份：`~/Documents/Docker/gist-nextflux/data.bak-0917-2217`
- [x] **10-11 星标再加一档「只显示当前视图」**（2026-09-17）：根因 —— `selectionToParams` 只对 `all` 传 `contentType`，
      星标视图**一律不带内容类型**，所以永远全类型。做法：给星标加 `scope=view` 维度（`SelectionType.starred.viewOnly`）——
      `router` 解析/生成该参数、`selectStarred(opts, viewOnly)`、`selectionToParams` 在这一档才带 `contentType`；
      侧栏在「已加星标」**上面**新增一行「当前视图星标」（带当前内容类型贴纸，两档互斥点亮）。
      实测：点它 → URL `/starred?scope=view&type=article`、只有该行 `data-active=true`；
      接口层机制验证（你库里只有 **1 条**星标条目、属 article 类型订阅，所以界面上两档看不出差别）：
      `starredOnly=true&includeMuted=true` → **1**；加 `&contentType=article` → **1**；加 `&contentType=social` → **0**；`picture` → **0** ✓
      门禁：`bunx tsc -b` 干净、`bun run test` **608/608**（router 老用例补 `viewOnly:false`，新增 scope=view 用例）
- [x] **10-12 图片视图**（2026-09-17，两半都实现 + 用户复看后修掉「格子一样高」）：
      **① 图片布局设置**（用户澄清：瀑布流 = 不规则那种、网格 = 等高正方格）：外观 → 按视图设置 → 图片 那一块新增「图片布局」
      （`ui-settings.pictureLayout`，默认 `masonry` 不规则瀑布流；选 `grid` 时 `PictureItem` 强制 1:1 正方格）。
      **② 灯箱左右箭头**（用户选 C）：同条目内先切图，切到头跳到**下一条目**的第一张（左箭头对称：退到上一条目最后一张）；
      跳条目时弹一条 1.8s 的简洁提示（来源 · 标题）；键盘 ←/→ 同语义；底部多一个画廊位置计数。
      实现：`lightbox-store` 加 `gallery/galleryIndex`（`open(entry, feed, images, idx, gallery?)`，不传就按单条目=老行为）、`PictureMasonry` 把已加载条目连图一起作为画廊传下去；
      单测：store 新增 5 例（条目内切图 / 跳到下一条目 / 回上一条目末张 / 两端不越界 / 不传画廊保持老行为）全过；全量 **614/614**、`tsc` 干净。
      **⛔ 没能端到端验的原因（既有 bug，非本轮引入）**：我这边的浏览器里图片视图 **渲染不出任何 item** ——
      `data-testid=virtuoso-list` 出来 N 个**空列**、连拍观察到 item **一闪就消失**（t2 有 6 个 → t3 起 0 个）；
      同时界面里**没有** EmptyState 文案（说明 `entries` 非空）、控制台只有 `ResizeObserver loop` 警告、也无重复请求；
      `git stash` 掉本轮改动后**同样是 0 项**，且接口层同一 token 同参数 `/api/entries?contentType=picture&hasThumbnail=true` 返回 **21 条** ✓。
      用户复看：「看得到图，但格子**一样高**」→ 已定位并修（见下）。
      **③ 格子一样高的真因（已修）**：图片命中**浏览器缓存**时不会再触发 `onLoad`，而 `PictureItem` 只在 onLoad 里记真实宽高 →
      尺寸永远没记下来、每个格子都退回默认 `DEFAULT_RATIO = 3/4`（实测：所有容器 `aspect-ratio: 0.75`）。
      修法：`imgRef` + 挂载时检查 `img.complete && naturalWidth/Height` 补记一次（onLoad 路径保留）。
      单测：新增 `PictureItem.test.tsx` 3 例 —— 未知尺寸仍 0.75；**模拟缓存图 → 挂载即记录 1200×400 且容器比例变 3**（格子才参差）；网格模式强制 1:1 ✓
      全量 **617/617**。**待你在 5173 复看**：刷新后图片视图的格子高度应该开始参差了（旧图第一次仍会先按 3:4 出现，加载/补记后即刻变形）。
- [x] **10-13 个人资料可修改头像**（2026-09-17）：原先头像**只能是邮箱的 Gravatar**（`gravatarURL(email)`，没有可改字段）。
      后端：新增设置键 `user.avatar_url`（空 = 沿用 Gravatar，**默认行为不变**），`PUT /api/auth/profile` 收可选 `avatarUrl`
      （不传 = 不动；空串 = 恢复默认；其余 = 直接用），三处返回头像的地方改走 `resolveAvatarURL()`；接口签名变更已 `make gen` 重生成 mock、`swag init` 重生成文档。
      前端：资料弹窗顶部加头像区 —— **上传图片**（`createImageBitmap` + canvas 压到 128px → JPEG data URL，几 KB）、**用图片地址**、**恢复默认头像**。
      实测：真实上传一张 196KB PNG → 库里 `user.avatar_url` 变成 **3195 字符的 `data:image/jpeg`**（≈2.4KB）、侧栏头像直接渲染该图（24px）；
      `/api/auth/me` 返回同值；点「恢复默认头像」→ 库里该键变空、预览回到默认 ✓。
      顺带修一个真 bug：`AvatarFace` 会缓存「加载失败」，Gravatar 404 后即使设置了新头像也仍显示首字母 → 改为 `avatarUrl` 变化时重置。
      门禁：后端 `make test` 全绿 + `make lint` 0 issues；前端 `bunx tsc -b` 干净、`bun run test` 607/607
- [x] **10-14 规则行右侧「⋯」菜单每一项都点不动（回归，优先修）**（2026-09-17 真实鼠标复现 + 修复 + 真点验证）：
      根因不在菜单本身 —— 打开 Modal/Drawer 时 react-aria 把 **`<body>` 设成 `pointer-events: none`**（点外部由 overlay 兜关闭），
      而 HeroUI 弹层是 portal 到 body 的兄弟节点、**继承了这个 none** → 真实点击穿透到 `<html>`（合成事件直接派发到元素，所以单测/脚本里是「好的」）。
      修法：`index.css` 给打开中的弹层恢复 `pointer-events: auto`。实测：弹层 `pe` none→auto、命中测试 `hitIsItem: true`、
      真实 `mouse.down` → `data-pressed=true` → `mouse.up` → **抽屉打开**

## 0.8 Bug 队列 2（2026-09-17 本轮发现）

- **BUG-3 图片视图渲染不出条目（既有 bug，与第十批改动无关）**
  - 现象（我的 ego 浏览器，:5173，桌面 1568×951 与移动 390×844 都一样）：图片视图只有头部「全部图片」，
    主体渲染出 N 个 `div[data-testid=virtuoso-list]`（**空列、height 0**），页面里 `[data-entry-id]` = 0；
    连拍 6 秒：t0 文章视图 50 项 → 切过后 t2 出现过 **6 项** → t3 起一直是 **0 项**（一闪就没）。
  - 已排除：
    - **不是本轮引入**：`git stash push PictureMasonry.tsx` 后现象相同（同样 0 项）。
    - **不是数据问题**：同一 token 同一参数（`contentType=picture&hasThumbnail=true&limit=50`）接口返回 **21 条**；库里该类型 21 条、均有缩略图。
    - **不是空状态**：界面里没有 EmptyState 的文案（`entry_list.no_articles`），说明 `entries` 非空。
    - **不是请求风暴**：无重复 `/api/entries` 请求；控制台只有 `ResizeObserver loop completed with undelivered notifications` 警告。
  - 线索：`virtuoso-scroller` 带着 `padding-bottom: 895px`（滚动标已读的尾部占位），而各 `virtuoso-list` 高度为 0；
    怀疑与 masonry 的测量/滚动容器 + 尾部 padding 的交互有关（`@virtuoso.dev/masonry@1.4.3`）。
  - 影响：图片视图的「瀑布流/网格」两档与灯箱箭头都**只能算代码级完成**，端到端验收待这条修好。

## 0.9 第十一批（2026-09-18 用户清单，18 项；原话记录）

> **本轮硬约束（用户本轮明确）**：所有样式改动**一律用 HeroUI v3 组件**，不许自己手搓/自创风格
> （涉及的现成件：`ListBox`、`Badge`、`ColorPicker`、`SegmentedControl`、`AlertDialog`/`Modal`、`ContextMenu`/`Dropdown`）。
> 取值仍要量 computed style 对齐 Nextflux；UI 改动一律 ego-browser 真点验证后才许勾。

- [x] **11-1 新建视图预览失败** —— 已修（2026-09-18）。真因：预览发出去的 body **没有 `kind`**，后端按「规则」校验 → 视图没动作 → 400 `invalid filter`；带 `kind:"view"` 同 body 是 200。
      修法：`FilterEditor` 抽出 `buildPayload()`，预览与保存共用（含 kind / name trim / 视图清空 actions）；单测 +2；真机预览实测 **200**。
- [x] **11-2 从设置里打开的抽屉关闭时连带关掉设置** —— 已修（2026-09-18）。根因：抽屉 portal 到 `body`，对设置的 **Radix Dialog** 是兄弟节点，Radix 的「外部点击关闭」和「Esc 关闭」都认不出它。
      修法：`SettingsModal` 在子浮层开着时对 `onInteractOutside` / `onEscapeKeyDown` 调 `preventDefault`。
      真机验证：点遮罩 → 抽屉关、设置在；按 Esc → 抽屉关、设置在（对照：修之前 Esc 会把设置一起关）。
- [x] **11-3 「撤销影响」语义** —— 已当面答（2026-09-18）。语义：按 `filter_matches` 找回该规则处理过的条目 → 当初静音/标已读的**退回未读**并清掉静音与归属；只加星等不动已读位的**只清归属/自动翻译/摘要标记、保留已读**；规则本身仍在生效（下次命中会重新标记）。
      **发现的语义缺口（待拍板）**：`ResetFilterState` 不动 `starred` → 「规则加星 + 撤销影响」后星标仍留着，看着像没撤干净。选项：① 保持（星标算用户自己的收藏动作）② 连星标一起撤（仅当这条星是规则加的）③ 撤销时对话框里给个勾选。
- [x] **11-4 条件区输入框加大** —— 已完成（2026-09-18）。抽屉内输入框统一 `h-9`（32→36px）；条件行五件套全部 36px（改前 32/36/32/32 参差）；**窄抽屉下值输入被挤成 22px** 的真问题一并修掉（行 `flex-wrap` + `min-w-[10rem]`，实测 22px → **308px**）。
- [ ] **11-5 筛选视图的显示方式**（原话：「『筛选视图』的显示可以设置固定只在某个视图下显示并且有右键菜单，还可以自定义图标」）——① 绑定内容类型（只在文章/社交/图片等某个视图下显示）② 右键菜单 ③ 自定义图标。
- [ ] **11-6 「更改类型」显示视图图标**（原话：「feed 右键『更改类型』显示视图图标」）——类型选项旁带对应视图（文章/社交媒体/图片/通知）图标。
- [ ] **11-7 第一栏分界限按视图显示**（原话：「加一个设置：第一栏的分界限可以自定义在哪个视图里显示。比如我切换到文章视图时，它就显示；切换到图片或社交媒体时，这个分界限就不显示」）。
- [ ] **11-8 第一栏右键「刷新」的联动 + 结果弹框**（原话：「第一栏右键点击『刷新』时，第二栏的刷新要有联动，并且弹框还要告知一共更新了多少个条目（如果点击的话会显示详情，具体哪个订阅更新了多少条，要带图标，然后得手动关闭，不点击倒计时 3s 关闭），如果失败告知失败原因，并可复制（这时得手动点击关闭）」）。
- [ ] **11-9 保存前二次确认**（原话：「任何更改，如果我点保存，提示是否保存」）——**待确认口径**（见下方问题）。
- [ ] **11-10 新引文样式：卡片**（原话：「添加新的引文样式：卡片」）。
- [ ] **11-11 feed 右键加「前往主站 / 复制主站地址」**（原话：「feed 右键单击，添加一个『前往主站』、『复制主站地址』条目，如果这个主站是 rsshub 的，解析下，比如推特：x.com/elonmusk 我们很容易就能解析出来这个地址就是这个 feed 的主页」）——需要 RSSHub 路由 → 源站地址的解析表（telegram/twitter/bilibili…）。
- [ ] **11-12 新的第一栏 feed 外观（HeroUI ListBox）**（原话：「基于 11，我们可以实现一种新的第一栏 feed 显示外观，使用 heroui 的 list-box，文字部分就是名称+@源站，鼠标悬浮源站可以直接跳转」）。
- [ ] **11-13 主题色可改（HeroUI ColorPicker）**（原话：「ColorPicker 组件，用这个，可以在外观里添加一个：修改主题色」）。
- [ ] **11-14 已读/未读样式统一且可切换 + Badge**（原话：「目前『已读、未读』有两种样式：一种是社交媒体视图前面的小蓝点，另一种是其他视图里的变灰。需要做成可切换的全局统一样式，然后再加一个使用这个组件：Badge」）。
- [ ] **11-15 第一栏收藏/视图显示数量 + 收藏「只显示当前视图」**（原话：「第一栏的收藏、视图，也要显示数量，另外，『当前视图收藏』是一个筛选，当点进去『收藏』后可以在收藏的上面点击『只显示当前视图的图标』或在第一栏『收藏』选项的右侧增加『只显示当前视图的图标』」）——与第十批 10-11 的 `scope=view` 是同一件事，这次要在第一栏给入口。
- [ ] **11-16 规则范围里「订阅」可多选**（原话：「规则里面的范围，订阅这块是可以多选的」）。
- [x] **11-17 「命中 N / 最近命中」那行** —— 已完成（2026-09-18）。整块收进一个 HeroUI `Button` + `Tooltip` + 行尾 chevron；实测整块是一个 24px 高的可点按钮，文案 `命中 5·最近命中 2026/9/17 23:35:24`。
- [ ] **11-18 动作区布局重排**（原话：「自动化规则下面的动作，布局在优化下，太乱了（图一）」） ——**已完成（2026-09-18）**。三态换 HeroUI `ToggleButtonGroup`（单选）、附加动作收进一个多选 `ToggleButtonGroup`（「只保留匹配」回到同一行）、说明从 5 段灰字收成 1 行 + tooltip、地址输入框紧跟开关。
      实测（四个开关全开、真实点击）：高度 **479px → 349px（−27%）**、灰字说明 **5 行 → 1 行**。坑：`TooltipTrigger` 要 `className="contents"`（否则拆散按钮行）、react-aria 的 ToggleButton 不响应合成 `.click()`（测量必须用真实鼠标事件）——实测截图确认的问题：三行分段控件左右不对齐、说明文字与控件穿插、四段灰字把交互元素切碎、「只保留匹配」孤零零右浮且描边比别的重、推送地址输入框与高亮的「推送到手机」之间隔了说明与另一个按钮（视觉上没有绑定感）、输入框只有一行占位却占了很大宽度。


### 第十一批的已拍板细节（2026-09-18 用户逐条回答）

| 项 | 拍板 |
|---|---|
| 11-9 保存提示 | **保存成功后只弹「已保存」提示（不拦截写库）**；**有未保存改动时离开（关抽屉/切走）才提示「是否保存？」** |
| 11-14 已读/未读统一样式 | 统一成 **HeroUI `Badge` 组件**做的那一种（默认就是 Badge 版）；小蓝点/变灰不再各写一套 |
| 11-12 第一栏 feed 外观 | **外观 → 阅读 里加「第一栏订阅外观」选项**：默认维持现状，可切「名称 + @源站」（HeroUI ListBox） |
| 11-10 引文样式「卡片」 | **新增卡片样式**，并在 **外观 → 阅读** 里给「引文样式」选择；原样式仍可选，**卡片为默认** |
| 11-5 视图自定义图标 | **两者都要**：先内置图标库（lucide）+ emoji 输入，再允许上传图片（复用头像那套 128px 缩放） |

### 第十一批的组件映射（用户本轮强调：样式一律用 HeroUI 组件；已装 `@heroui/react` **3.2.5**，88 个组件）

| 项 | 用哪个 HeroUI 组件（不许手搓） |
|---|---|
| 11-5 视图右键菜单 / 自定义图标 | `menu`（已有右键菜单基座）+ `popover`（图标选择器）+ `tabs`（内置库 / emoji / 上传三段） |
| 11-6 「更改类型」带视图图标 | `menu` / `list-box-item`（带 `icon` 槽） |
| 11-9 已保存提示 / 离开确认 | `toast`（项目已有 toast-store）+ `alert-dialog`（未保存离开时确认） |
| 11-10 引文卡片样式 | `card`（+ 现有 prose 排版） |
| 11-12 第一栏订阅外观 | `list-box` + `list-box-item` + `list-box-section`（分组），源站用 `link` |
| 11-13 主题色 | `color-picker`（内含 `color-area` / `color-slider` / `color-swatch-picker`） |
| 11-14 已读/未读统一样式 | `badge`（默认样式）+ `toggle-button-group`（外观里切换：Badge / 变灰） |
| 11-15 数量角标 | `chip`（或 `badge`，与 11-14 保持一致）+ `toggle-button`（「只显示当前视图」图标开关） |
| 11-16 规则范围订阅多选 | `select`（`selectionMode="multiple"`）或 `combo-box` + `tag-group` 展示已选 |
| 11-17 命中/最近命中行 | `button`（可点击的「最近命中」）+ `tooltip`（说明点了看什么） |
| 11-18 动作区重排 | `toggle-button-group`（三态：不变/正/反）+ `button-group`（动作开关）+ `fieldset`/`label`（分组），间距按 Nextflux 量 |
| 11-8 刷新结果弹框 | `alert-dialog` 或 `popover` + `progress-bar`（刷新中）+ `scroll-shadow`（条目明细列表），失败原因用 `close-button` 关闭 + 复制按钮 |

## 0.10 第十一批续（2026-09-18 用户第二批，5 项；原话记录）

- [ ] **11-19 刷新右键「强制拉取」**（原话：「在刷新图标右键可以强制拉取（忽略之前拉取的时间戳，再重新拉一次）；如果当前范围太多（有可能是误选），要谈个确认框」）——右键刷新图标 → 「强制拉取」= 忽略 etag/last-modified 与「多久内不重复抓」的判定，整轮重抓；条数超阈值先弹确认（HeroUI `alert-dialog`）。
- [ ] **11-20 拉取频率与并发做成可配置** —— **现状已答（照代码）**：定时刷新 **15 分钟**一轮（`scheduler.New(..., 15*time.Minute)`，单轮上限也是 15 分钟）；全局并发 **8**；**同主机并发 6**；单源抓取超时 **15s**。
      待做：把这四个做成**设置项**（建议落 设置 → 高级，或「订阅」页），改完即时生效（现在都是编译期常量，要 thread 进 refresh_service / scheduler）。
- [~] **11-21 外部地址不可达时整个应用卡死**（用户补充：转圈的是**整页刷新**、**会自愈**、当时用的是**没加 https** 的 Bark 地址；据此「Bark 坏 → 全站卡死」基本排除——没协议头只会瞬间报错，而且他库里存的实际是带 https 的地址）（原话：「如果bark的链接有问题，发不到我手机，那么整个软件都会卡死，比如这时刷新网页会一直转圈，这应该不是只有bark才会有的问题」）
      **后端已排除**（实测反证，见 `docs/变更记录.md` 同名条目 + `~/Documents/test/gist-nextflux-e2e/repro-notify-hang.py`）：推送地址指向「只接受连接不回应」的假服务时，`/api/notify/test` 10s 超时返回 502；它挂着的 30s 里 `/api/feeds` 中位 0.0s、最大 0.14s；156 个并发挂起 + 失败爆写 `last_error` 期间也最大 0.01s。
      **已修前端兜底**：`request()` 加 30s 超时（与调用方 signal 合并），超时给可见原因；单测 +3、全量 622/622。
      **待用户补复现细节**：转圈的是「刷新网页」还是刷新按钮？会不会自己恢复？Bark 地址是 https 域名还是 IP？当时是否在跑回溯/定时刷新？
- [ ] **11-22 引文样式要在所有视图生效**（原话：「社交媒体或或其他视图，当产生移动文件夹或 fold 到其他视图动作时，假如把文章的内容移到社交媒体里面，它在社交媒体里面的那个引用是不会被框住的，也就是它不会显示引文的样式。所以这也提醒我了：只要有引文，不管是在文章、通知还是社交媒体里面，都应该要把引文的样式展示出来」）——引文（quote/blockquote）规范化与样式要抽成共享渲染，社交媒体/通知/图片视图里的条目正文同样走它。
- [ ] **11-23 「撤销影响」先给受影响条目清单**（原话：「规则下的『撤销影响』，撤销前给出一个会受影响的条目，然后可以选择这些条目，选择哪个或多个应该执行撤销」）——撤销前弹列表（可多选/全选），只撤销勾选的；与 11-3 的「星标要不要一起撤」一起定。

## 1. 过滤规则（自动化） · 细节见 `docs/自动化-过滤规则.md`

### 已完成（P1 全部 + P2 三项）

- [x] 迁移 21：`filters` + `filter_matches` + `entries.muted` / `filter_id`
- [x] 引擎：条件求值（正则 / 取反 / and-or / 日期 / 布尔 / 空值）、scope 三层、**首个命中即停**、`keepOnly` 落空退化静音、命中审计与计数、撤销
- [x] 引擎挂在**两条入库路径**之后（`refresh_service.saveEntries` / `feed_service.Add`），只对刚入库的新条目生效
- [x] 接口 8 个：CRUD、`preview` 干跑、`revert`、`matches` 命中日志、`/entries/:id/unmute` 条目级反悔、列表 `includeMuted` / `mutedOnly`
- [x] 前端：设置 → 自动化（规则表格 + ↑↓ 顺序 + 启停 + 撤销影响 + 删除确认 + 回溯入口 + 命中数入口）
- [x] 前端：规则编辑器抽屉（范围 / 条件行 / 正反成对动作 / 常驻预览）、中栏「已静音」胶囊、条目「已静音 · 规则名」标签
- [x] 前端：两处右键入口（条目「按此条新建规则」/ 订阅「为此订阅新建规则」）
- [x] 中英 i18n（各 113 键，无漂移）
- [x] 测试：引擎 10 + 服务 11 + handler 14 + 两条入库路径各 1；前端新增 19 例
- [x] 实测：后端门禁 + HTTP 端到端 + ego-browser 三轮 + 合并演练
- [x] 命中日志页（P2 提前做）：规则表点「命中数」→ 时间 / 条目（标题+来源）/ 动作
- [x] 历史条目回溯（P2 提前做）：`POST /api/filters/:id/apply`，幂等、首个命中即停、含已静音条目

### 待办（P2）· 2026-09-17 第二轮：已做 5 项，2 项明确不做、1 项待通道

- [x] **保存筛选视图**：`filters.kind = view`（同一张表：范围 + 条件，**没有动作**），设置 → 自动化下半区「筛选视图」新增/编辑/删除，
      侧栏多一个「视图」区做日常入口；列表走 `GET /api/entries?viewId=`，
      **条件求值与规则引擎共用同一个 `MatchConditions`**（不会两套语义），作用域内最多回看 1000 条再按 offset/limit 切片
- [x] **条目详情「豁免这类内容」**：`POST /api/filters/exception` —— 建一条顺序最靠前（position 会到负数）、
      只做反向动作（unmute + markUnread）的例外规则，条件默认「同一链接（exact）」，并**立刻放行这一条** + 记一次命中
- [x] `translate` / `summary` 动作：**只给条目打「打开时自动翻译 / 自动摘要」标记**（`entries.auto_translate` / `auto_summary`），
      真正翻译/摘要发生在打开这条时（复用既有 SSE 通道）—— 刻意不在入库时花 AI token，也就不需要队列与并发控制
- [x] `webhook` 动作：命中后**异步** POST JSON 报文（走 `network.ClientFactory`，继承代理设置，10s 超时），
      投递失败/成功都写回规则的 `last_error`（规则表行内红字可见），成功自动清掉上一次的错误
- [x] `notify` 动作 —— **已完成（2026-09-18）**。规则里可填 Bark 地址，留空则跟随 设置 → 通用 的全局地址；
      命中后异步推送「条目标题 + 来源 · 规则名 + 直达链接」，投递结果同样走规则的 `last_error`（前缀「推送失败：」）。
      设置页有「发送测试推送」按钮；地址里的设备 key 属凭证，只存用户库，`last_error`/日志里已脱敏成主机名。
      实测：库副本 + 本地 Bark 桩跑通四件事（保存/测试推送/规则命中真推/失败原因可见且 key 未泄漏）；前端 617/617、tsc 干净；
      `:8080` 已上新二进制。**待用户填入自己的 Bark 地址**（或让我代填）。
- [x] `block`（命中不入库）—— **决定不做**：MrRSS 也没这动作；静音已可回看、可反悔，block 不可逆
- [x] 规则 JSON 导入导出 —— **决定不做**：单人自用价值低，且与「自然语言建规则」重复
- [x] 小瑕疵：详情页引文最终效果 —— 2026-09-17 用 ego-browser 打开一条带引文的条目截图人工过眼：
      左边框 + 缩进正常、无底色、无裁切、emoji 与删除线正常（截图 `~/Documents/test/gist-nextflux-e2e/quote-detail.png`）

### 待办（P3）· 2026-09-17 第二轮：两项都做了

- [x] **AI 条件**：条件字段 `ai_relevance` + 操作符 `is_relevant`（值 = 主题描述，≤200 字），
      用已配置的 AI provider 判断「这条与我给的主题相关吗」；判定按 `(条目, 主题)` **永久缓存**（`entry_ai_judgements`），
      成本护栏三条：正文 <400 字不判、单次运行最多 5 次、进程内 10 分钟最多 60 次；
      没判成的原因（未配置 / 调用失败 / 正文过短 / 到上限）写回**那条规则**的 `last_error`，预览只吃缓存、绝不新发起调用
- [x] **自然语言建规则**：`POST /api/filters/parse` → LLM → 规则草稿（**不落库**），
      草稿自动填进编辑器抽屉（带模型的 `notes` 与被修正/丢弃项的 `warnings`），用户改完确认才保存；
      prompt 里带真实订阅/分类 id 清单，模型编的 id、非法字段/正则、冲突动作会被纠正或丢掉并明说；
      AI 未配置 → 400 `ai_not_configured`，模型输出没法用 → 422 `ai_draft_invalid`

## 2. 部署与验收

- [ ] 本机 Docker 打包部署（用户已明确：暂缓，先磨细节）
- [ ] 本机 Docker 部署验收（NAS 待定；**收尾要重新 build 镜像**，现镜像已旧）
- [ ] 移动端与 PWA 回归

## 3. 待观察（缺样本 / 需人看一眼，先挂着）

- [ ] 社交视图图片偶发加载不出 / 少加载（未复现；需要"哪个订阅 + 第几张图"的样本）
- [ ] 免费翻译"关掉兜底时只报错不兜底"缺失败样本（连打 12 次有道全部成功，没造出失败）
- [ ] 详情页引文渲染效果人工确认（同上）
- [ ] 想看 NextFlux 逐帧动效，需要先在 Ego 里登录 NextFlux（http://192.0.2.1:3100）再比

## 4. 待拍板

- _（当前为空；「界面字号」其实早已实现，旧文档里的待定条目已作废）_

## 5. 已完成（一行索引 · 明细与实测数字见 `docs/变更记录.md`）

- [x] 2026-09-16 调研两仓库、定基座与路线、建项目（`docs/调研-2026-09-16.md`）
- [x] 皮肤层：HeroUI v3 + 设计 token + 5 套主题 + 卡片列表 + 侧栏 + 浮层正文 + 工具条
- [x] 第二批（8 项）：刷新转圈与剩余计数、添加订阅真实预览、RSSHub 记住、订阅真图标、改名 krss、多提供商等
- [x] 第三批（11 项）：GitHub 图超时（代理 + azuretls 降级）、界面字号、同主机并发、免费翻译通道、订阅级 `reader_mode`、分类批量设置等
- [x] 第四批：加号/右键/账户菜单按 NextFlux 真机数值重做；有道通道与免费通道失败兜底
- [x] 第五批：社媒视图自我已读（恶性）、刷新异步化（125.6s → 0.0007s）、返回按钮遮挡、飞行头像、引文只剩引文
- [x] 第六批：过滤规则（自动化）P1 —— 见上
- [x] 第七批：搜索（`f` / `⌘K`）、刷新进度口径、正文视频代理（含 Range）、引文容器与引文样式、订阅区全部展开
- [x] 2026-09-17 过滤功能合并进 main（含合并演练抓到的 `Search` 列数 bug、jsdom WAAPI 导致的"全绿但退出码 1"）
