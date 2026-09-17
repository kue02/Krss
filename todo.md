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

- [ ] **1. 搜索结果的来源标签 / 头像**：条目结果在每条后面补「订阅来源名」标签；订阅结果前面补订阅头像（复用 `feed-icon`）
- [x] **2. 菜单对齐 Nextflux**
  - [x] 账户（Kue）单击弹出框：**改用 HeroUI v3 `Dropdown`**（照 Nextflux `ProfileButton` 的结构：Popover placement="top left" + Menu onAction + Item id/textValue + lucide 图标），**已去掉「已加星标」**
        —— 实测：触发器类名 `dropdown__trigger`、菜单 4 项（个人资料/设置/快捷键/退出登录）、宽 187px、无「已加星标」（ego-browser 真点）
  - [x] **连带修**：`StarredItem` 组件写了但**全项目从未渲染**——账户菜单是星标唯一入口，删掉会让功能失联；
        已按 Nextflux 的位置把它挂到侧栏导航顶部（实测：点击后 `data-active=true`）
  - [ ] feed / 文件夹右键菜单：加图标 + 弹出框标题，项与 Nextflux 对齐（含分组与危险项样式）
- [ ] **3. Krss 左侧加号菜单**：新增「新建自动化」入口；移除「导入 OPML」（导入改走 设置 → 数据控制）
- [ ] **4. 设置 → 自动化页重构**（现表格被压得看不清）：定位为**纯管理页**——规则列表 + 视图列表分开，
      行内不再堆按钮（改行尾「⋯」菜单）、错误以行内提示 + tooltip 呈现；编辑器抽屉一起重做
- [ ] **5. 中栏筛选胶囊去掉「已静音」**：静音回看入口移入自动化页（列表默认隐藏静音，不再占高位入口）
- [ ] **6. 自动化编辑器（右侧抽屉）重构**：桌面保留抽屉、移动端改全屏 Sheet（考虑移动端输入与滚动体验）
- [ ] **7. 正文代码块**：适配 + 语法高亮 + 行号（对齐 Nextflux 的 shiki 实现；按需加载语言，避免拖慢首屏）
- [ ] **8. 自动化顺序改拖动**（现在是 ↑↓ 按钮）：拖拽手柄 + 位移动效，落库仍用 position
- [ ] **9. 细调与性能**（贯穿全批）
  - [x] 下拉框换 HeroUI 组件：新增 `src/components/ui/select.tsx`（HeroUI v3 `Select` + `ListBox`，react-aria 引擎、自带弹层动效/键盘/触摸），
        **设置页 4 处已换**（AI: provider / 摘要语言 / 翻译通道；设置弹窗移动端 tab 选择器）
        —— 实测：`select__trigger` → 弹层 `data-slot="list-box"` 带 3 个 option（ego-browser 真点）
  - [ ] `FilterEditor` 里剩下的 4 处原生 `<select>`：随第 4/6 项重构一并换（避免改两遍）
  - [x] **性能基线实测（改动前取证）**：`language-detect-*.js` **454 KB(gzip)**（全站最大，懒加载但列表判定语言即拉起）；
        条目列表**无虚拟化**（只有社交流用的 `@virtuoso.dev/masonry`）；`EntryListItem` **无 `memo()`** → 列表状态一变就重渲染所有卡片；
        `framer-motion` 与 `motion` 12.x **双份依赖**；`dist/assets` 里已有 shiki 语言分块（cpp 46KB、ts/tsx/jsx 各 16KB）
  - [ ] 动画/动效流畅度对齐 Nextflux：按上面基线逐项改（虚拟化 / memo / language-detect 降级 / 去重动画库），每项留改前改后数据
  - [ ] `notify` 动作（Bark）一并做掉（见上一节 P2）



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
