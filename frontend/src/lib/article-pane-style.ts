/**
 * 「正文栏样式」到「内联工具栏背景层是否保留 backdrop-blur」的映射。
 *
 * 卡片档 pane 用 `overflow: clip` 裁圆角；Chromium 下带 backdrop-filter 的层会让祖先圆角的
 * 边框/阴影合成出错，表现为滚动后点开正文、卡片左上角缺一块，所以卡片档必须关掉模糊。
 * 「原样」档用 `clip-path` 裁圆角，没有这个问题，保留模糊（按用户 2026-11-24 的要求，原样档不动）。
 */
export function headerBackgroundBlurFor(
  style: "card" | "plain" | undefined,
): boolean {
  // 缺省即卡片档（useUISettingKey 的默认值），只有「原样」档保留模糊。
  return style === "plain";
}
