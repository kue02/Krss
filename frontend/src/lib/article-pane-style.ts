/**
 * 「正文栏外框」到「内联工具栏背景层是否保留 backdrop-blur」的映射。
 *
 * 卡片档 pane 用 `overflow: clip` 裁圆角；Chromium 下带 backdrop-filter 的层会逃逸祖先圆角的
 * 裁剪，表现为滚动后点开正文、卡片左上角缺一块。修复方式是让模糊层自带顶部圆角
 * （见 `headerBackgroundRoundedTopFor`），由 `backdrop-filter` 按自身 border-box 裁剪，而不是
 * 关掉模糊；因此卡片档与「原样」档都保留磨砂（按用户 2026-11-25 的要求）。
 */
export function headerBackgroundBlurFor(
  _style: "card" | "plain" | undefined,
): boolean {
  // 卡片档此前为规避 `overflow:clip` 圆角缺块关掉了磨砂；现在模糊层自带顶部圆角
  // （见 `headerBackgroundRoundedTopFor`），backdrop-filter 会按自身圆角裁剪，
  // 因此两档都保留磨砂（「原样」档本来就有）。
  return true;
}

/**
 * 顶栏背景层是否要自带顶部圆角（12px）。
 *
 * 卡片档保留磨砂时，模糊层自己是 `backdrop-filter` 元素：Chromium 不会用祖先
 * `overflow: clip` 的圆角去裁它，方角会盖住卡片圆角（缺块）。让这一层自己带圆角后，
 * `backdrop-filter` 的输出会按自身 border-box（含 border-radius）裁剪，方角就没了。
 *
 * 只有「卡片档 + 正文栏非贴顶（此时 pane 是 12px 圆角）」需要；贴顶档 pane 是
 * `rounded-none`，加了反而在直角处露出内层底色；「原样」档用 `clip-path` 裁圆角本身
 * 就能裁住 `backdrop-filter`，不需要。
 */
export function headerBackgroundRoundedTopFor(
  style: "card" | "plain" | undefined,
  paneAtTop: boolean,
): boolean {
  return style !== "plain" && !paneAtTop;
}

/**
 * 正文栏外框（用户 2026-11-25：三档切换后定稿；同日再把原来的「原样」并进来）。
 *  - subtle：默认，边框降到 40% 几乎看不见，投影改成一层极轻的 2px；
 *  - none：卡片档完全不画边框和投影；
 *  - full：原来的「原样」，无边框、铺满整栏（不再走卡片容器的留白/圆角外框）。
 */
export type ArticlePaneFrame = "subtle" | "none" | "full";

/** 外框档位 → 正文栏容器形态：full 是原来的全宽「原样」档，其余都是卡片档。 */
export function articlePaneStyleForFrame(
  frame: ArticlePaneFrame,
): "card" | "plain" {
  return frame === "full" ? "plain" : "card";
}

/** 卡片档非贴顶时叠加到 pane 上的边框 + 投影类；full 不走这里，未知值按默认 subtle 处理。 */
export function articlePaneFrameClasses(frame: ArticlePaneFrame): string {
  switch (frame) {
    case "none":
      return "border-0 shadow-none";
    case "full":
      return "";
    case "subtle":
    default:
      return "border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
  }
}
