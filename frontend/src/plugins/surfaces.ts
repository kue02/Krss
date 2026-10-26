/**
 * 宿主暴露的「可插入位置」名单（56-4）。
 *
 * 顺序与取值与后端 backend/internal/plugin/contribution.go 的 `Surfaces` 必须同步：
 * 这份名单由 krss 单方面决定，插件只能用这些；前端多一个 / 少一个都会让界面装不上
 * 后端认可的贡献项（或反之，装了后端根本不认的挂点）。
 */
export const SURFACES = [
  "entry.contextmenu",
  "entry.list.toolbar",
  "entry.reader.toolbar",
  "entry.reader.body",
  "feed.contextmenu",
  "filter.editor.footer",
  "settings.section",
  "app.command",
  "view.toolbar",
] as const;

export type Surface = (typeof SURFACES)[number];
