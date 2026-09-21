# AGENTS.md —— gist-nextflux 项目规则（可移植版）

> 这份文件给**所有** AI 编码工具看（Codex / Claude Code / OpenCode / Cursor…）。
> 在 Hermes 里，同一套规则的权威版本是 `.hermes.md`（Hermes 会从仓库任意子目录向上找到它并自动加载；
> 本文件在 Hermes 下只作为 cwd=仓库根时的备用/给其他工具用）。**两份内容不一致时，以 `.hermes.md` 为准。**

## 一、必须遵守（违反即验收不合格）

1. **界面、动画、动效、样式优先用 HeroUI v3（https://heroui.com/），HeroUI 没有的照 Nextflux 的既有实现补**，不手搓复刻、不自创风格；
   取值要量 computed style，不许凭肉眼估。动手前先查 HeroUI 有无现成组件：`https://heroui.com/react/llms.txt`（索引）、
   `https://heroui.com/react/llms-components.txt`（仅组件）、`https://heroui.com/react/llms-patterns.txt`（模式片段），
   或 MCP `heroui-react`、`.agents/skills/heroui-react/`。HeroUI 没有的（右键菜单、图片灯箱、跑马灯等）照 Nextflux 实现补，不算违规。
   参考：`references/nextflux/`（源码）、http://192.0.2.1:3100（线上实例，需登录）、
   `references/folo/`（信息流形态）、`docs/移植笔记.md`（已对齐的实测值）。
   HeroUI 版本升级先在草图验 API 变化，再进真项目。**这条不满足 = 直接不合格。**
2. **所有任务先列进 `todo.md`，做一项勾一项**，提交与汇报要能对应到 `todo.md` 的条目。
3. **全部实测**：后端真打接口、前端在浏览器里真点（Hermes 下用 ego-browser）；没有实测证据不许勾。
4. 用户说"去看 xxx"就必须去看，看完给结论。
5. 收尾自查：不许留"没测 / 没做完 / 有 bug"的勾选。

## 二、文档分工

`todo.md` 唯一任务清单 · `IDEA.md` 想法/需求/决策/边界（不记进度） · `docs/变更记录.md` 批次流水 + 实测证据 ·
`docs/移植笔记.md` 技术细节与坑 · `docs/自动化-过滤规则.md` 过滤模块 · `docs/archive/` 留档 · `app/AGENTS.md` 代码规范。

## 三、代码与提交

- 后端 Go：`modernc.org/sqlite`（无 CGO）、黑盒测试（`package xxx_test` + testify `require`）、mock 用 `make gen` 重生成、
  接口改动跑 `swag init`；只动必要的一处、不改既有行为语义。
- 前端 React/TS：禁止 `any`；i18n 中英必须同步；HTML 渲染走 `unified` + `rehype` 管道。
- 提交规范：Conventional Commits + 简体中文标题；**只 `git add <具体路径>`**，不要 `-A`；`main` 历史只前进。
- 迁移编号：21 已被过滤功能占用，新的从 22 起。
- 质量门：后端 `cd app/backend && make test && make lint`；前端 `cd app/frontend && bun run test`（退出码 0）+ `bunx tsc -b`。
- 并行开工：用 git worktree，各自分支各自目录；`:8080` + 主库归主树，另一个用 `:8082` + 自己的库副本。
