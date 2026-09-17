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
- [ ] **10-4 RSSHub 换链接导致订阅地址相同时：弹框确认覆盖并合并为一个源**
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
- [ ] **10-9 设置项重复与逻辑梳理**：「外观 → 暗色模式」是重灾区；另有「滚动标记已读」关闭时「已读判定」是否还该显示/可选
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
- [ ] **10-12 图片视图**：加瀑布流设置；点开图片后左右加箭头可切换上一张/下一张
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
- [ ] `notify` 动作 —— **通道已定：Bark**（2026-09-17 用户拍板）。做法：规则里可填 Bark 地址（或跟随设置里的全局 Bark 地址），
      命中后异步推送（标题 + 来源 + 链接），投递结果同样走规则的 `last_error`。详见第九批清单
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
