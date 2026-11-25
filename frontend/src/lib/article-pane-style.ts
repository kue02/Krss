/**
 * 「正文栏样式」到「内联工具栏背景层是否保留 backdrop-blur」的映射。
 *
 * 卡片档 pane 用 `overflow: clip` 裁圆角；Chromium 下带 backdrop-filter 的层会让祖先圆角的
 * 边框/阴影合成出错，表现为滚动后点开正文、卡片左上角缺一块，所以卡片档必须关掉模糊。
 * 「原样」档用 `clip-path` 裁圆角，没有这个问题，保留模糊（按用户 2026-11-24 的要求，原样档不动）。
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
