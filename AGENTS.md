# AGENTS.md —— Krss 项目规则

> 这份文件给**所有** AI 编码工具看（Codex / Claude Code / OpenCode / Cursor / DSH…），是 Krss 的**唯一权威规则来源**。
> `docs/dev/` 下的文档（todo / IDEA / 变更记录 / 移植笔记 / 发版）只在本机、已被 `.gitignore` 忽略；换了机器或新 clone 没有这些文件，照本文件的规则做即可。

## 一、必须遵守（违反即验收不合格）

1. **界面、动画、动效、样式优先用 HeroUI v3（https://heroui.com/），HeroUI 没有的照 Nextflux 的既有实现补**，不手搓复刻、不自创风格；
   取值要量 computed style，不许凭肉眼估。动手前先查 HeroUI 有无现成组件：`https://heroui.com/react/llms.txt`（索引）、
   `https://heroui.com/react/llms-full.txt`（完整）、`https://heroui.com/react/llms-components.txt`（仅组件）、
   `https://heroui.com/react/llms-patterns.txt`（模式片段），或 MCP `heroui-react`、`.agents/skills/heroui-react/`。
   HeroUI 没有的（右键菜单、图片灯箱、跑马灯等）照 Nextflux 实现补，不算违规。参考：`docs/references/nextflux/`（源码）、
   http://192.0.2.1:3100（线上实例，需登录）、`docs/references/folo/`（信息流形态）、`docs/dev/移植笔记.md`（已对齐的实测值）。
   HeroUI 版本升级先在草图验 API 变化（3.0→3.2 的 Modal API 变更即教训），再进真项目。**这条不满足 = 直接不合格。**
2. **任务先记进 `docs/dev/todo.md`，做一项勾一项**，提交与汇报能对应到条目；**一批做完就把该批整段归档到 `docs/dev/archive/`**，`todo.md` 只留「未完成 + 待观察 + 待拍板」。
3. **全部实测**：后端真打接口、前端用 ego-browser 在浏览器里真点；没有实测证据不许勾，实测数字写回 `docs/dev/todo.md` 或 `docs/dev/变更记录.md`。
4. 用户说"去看 xxx"就必须去看，看完给结论。
5. 收尾自查：不许留"没测 / 没做完 / 有 bug"的勾选；拿不准的标进 `docs/dev/todo.md` 的「待观察」。

## 二、文档分工

`docs/dev/todo.md` 唯一任务清单（只留未完成/待观察/待拍板，完成批次进 `docs/dev/archive/`） · `docs/dev/IDEA.md` 想法/需求/决策/边界（不记进度） ·
`docs/dev/变更记录.md` 批次流水 + 实测证据 · `docs/dev/移植笔记.md` 技术细节与坑 · `docs/dev/自动化-过滤规则.md` 过滤模块 ·
`docs/dev/发版.md` 发版口径（**每次发版前必读**） · `AGENTS.md` 代码规范。

发版规则（细节见 `docs/dev/发版.md`）：版本号严格 Semantic Versioning 2.0.0（只 `MAJOR.MINOR.PATCH` 三段，禁四段），只改 `frontend/package.json` 与 `backend/internal/config/config.go` 两处；发布说明照 Keep a Changelog 1.1.0（`CHANGELOG.md` 为准，`docs/releases/v<版本>.md` 复制其版本节），**只写更新了什么，不出现批次号/内部编号**。顺序：功能先提交 → bump 版本 + 发布说明 → `git tag v<版本>` → 推 `main` 与 tag。
Docker 镜像同流程：tag 一推 `release.yml` 同时构建推 `ghcr.io/kue02/krss`（amd64+arm64）；发完必须核对 `:<版本>` 与 `:latest` 同 digest、且与上一版不同，不许只看 CI 绿就报「发版完成」。

## 三、代码与提交

- 后端 Go：`modernc.org/sqlite`（无 CGO）、黑盒测试（`package xxx_test` + testify `require`）、mock 用 `make gen` 重生成、
  接口改动跑 `swag init`；只动必要的一处、不改既有行为语义。新开的口子（新接口 / 新迁移 / 新字段）要写清理由。
- **两条入库路径都要检查**：`refresh_service.saveEntries()` 与 `feed_service.Add()`（任何「入库后要做事」的功能都躲不过这条）。
- 前端 React/TS：禁止 `any`；i18n 中英必须同步；HTML 渲染走 `unified` + `rehype` 管道。
- 提交规范：Conventional Commits + 简体中文标题；**只 `git add <具体路径>`**，不要 `-A` / `git add .`；`main` 历史只前进。
- **提交信息禁止出现 `Co-Authored-By: Hermes Agent`**：该署名邮箱绑定了无关的 GitHub 账号，会把合著算到别人头上、污染仓库 Contributors 图（2026-11-22 已因此重写历史清除一次）。协作署名只写真实贡献者，或干脆不写。
- 迁移编号：**不要写死数字，取 `backend/internal/db/migrations.go` 里最后一个 `Migration` 号 +1**（历史上 21 过滤 / 25 视图图标 / 26 代理 / 27 MCP）。给**已经跑过迁移的开发库**补字段要**新建号**，不要改已应用的迁移（`addColumnIfMissing` 在已迁移副本上不会再生效，表现是「改了没反应」）。
- 质量门（提交前）：后端 `cd backend && make test && make lint`（`PATH="$HOME/go/bin:$PATH"`；接口改过记得 `make gen` 重生成 mock、`swag init` 重生成文档）；前端 `cd frontend && bun run test`（退出码必须 0）+ `bunx tsc -b`。
- **子树并行修改与集成（必须遵守）**：规则见 `docs/subtree-parallel-workflow.md`，除非用户明确要求「直接在主树做」，否则一律按该文档执行。用 git worktree：各自一条分支、各自目录，基线显式写 `main`：`git worktree add .worktrees/<名字> -b feat/<名字> main`（`.worktrees/` 已写进 `.git/info/exclude`，不要提交它）。
  - **各树各开各的端口、各用各的库副本，绝不互相干扰**：`:8090` + 真实库只归主树；并行树用 `:8082` 起（一棵一个），库用副本 `data-<名字>`；前端 `KRSS_DEV_BACKEND=http://localhost:808X bun run dev --port 517X`。
  - **各树做完不许自己往 `main` 合并**，合并由用户在主树新开 session、主动指派「合哪棵子树」后才做；口径变了 / 上下文满了要换会话接着干时，**换 session，不换树**（重开树等于白扔已跑通的后端骨架与测试）。
  - 多棵树共同的热点文件（`migrations.go`、`locales/*/common.json`、`api/index.ts`、`types/api.ts`、`hooks/useUISettings.ts`、`AppearanceSettings.tsx`、`index.css`、`refresh_service.go`）请小步提交，便于合并前 rebase。
