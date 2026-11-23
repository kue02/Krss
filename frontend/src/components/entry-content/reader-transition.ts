/**
 * 第三栏（正文区）的两套转场 —— 对齐 Nextflux
 * `docs/references/nextflux/src/components/ArticleView/ArticleView.jsx`。
 *
 * 触发条件判定（纯函数，方便单测）：
 *   - null → 有 id：首次推进（外层整块从右侧推入）
 *   - 有 id A → 有 id B（A ≠ B）：切换滑动（内层正文上下滑动）
 *   - 有 id → null：关闭（退出动画走推进的反向：滑回右侧）
 *   - 同 id / null → null：无转场
 *
 * 数值全部抄自 Nextflux 原件（出处见下方注释）：
 *   推进（外层）：initial { opacity: 1, x: "100vw" } → animate { opacity: 1, x: 0, scale: 1 }，
 *     exit 有 id 时 { opacity: 1, x: "100vw", scale: 1 }；
 *     transition { duration: 0.5, type: "spring", bounce: 0, ease: "easeInOut" }。
 *   滑动（内层）：initial { y: 50, opacity: 0 } → animate { y: 0, opacity: 1 }
 *     （opacity 额外 delay 0.05），exit { y: -50, opacity: 0 }，
 *     transition { bounce: 0, ease: "easeInOut" }，mode="wait"。
 *   注意：内层**没有方向反转** —— 向上切 / 向下切都是下方 50px 进入、上方 -50px 退出。
 */

export type ReaderTransitionKind = "push" | "slide" | "close" | "none";

/** 外层推进的 key：只看「有没有选中」，不看具体是哪篇（与 Nextflux 的 key={articleId ? "content" : "empty"} 同语义） */
export function pushPaneKey(entryId: string | null): "content" | "empty" {
  return entryId ? "content" : "empty";
}

/** 内层滑动的 key：具体条目 id（与 Nextflux 的 key={articleId} 同语义） */
export function slideContentKey(entryId: string | null): string | null {
  return entryId;
}

/**
 * 由「上一次选中的 id → 这一次选中的 id」判定触发哪套转场。
 * 供单测与文档使用；组件里实际靠 AnimatePresence 的 key 切换自然触发，
 * 这里的判定保证语义与 Nextflux 一致：
 *   首次（null → 有值）= push；切换（A → B）= slide；关闭（有值 → null）= close。
 */
export function resolveReaderTransition(
  prevEntryId: string | null,
  nextEntryId: string | null,
): ReaderTransitionKind {
  if (prevEntryId === nextEntryId) return "none";
  if (prevEntryId == null && nextEntryId != null) return "push";
  if (prevEntryId != null && nextEntryId == null) return "close";
  return "slide";
}

/** 推进（外层）的 transition —— 抄自 ArticleView.jsx L168-173 */
export const PUSH_TRANSITION = {
  duration: 0.5,
  type: "spring",
  bounce: 0,
  ease: "easeInOut",
} as const;

/** 滑动（内层）的 transition —— 抄自 ArticleView.jsx L202（bounce: 0, ease: "easeInOut"） */
export const SLIDE_TRANSITION = {
  bounce: 0,
  ease: "easeInOut",
} as const;

/** 推进（外层）的 initial/exit —— 抄自 ArticleView.jsx L155-159（initial）与 L161-167（exit） */
export const PUSH_INITIAL = { opacity: 1, x: "100vw" } as const;
export const PUSH_ANIMATE = { opacity: 1, x: 0, scale: 1 } as const;
export const PUSH_EXIT_WITH_ENTRY = { opacity: 1, x: "100vw", scale: 1 } as const;

/* ------------------------------------------------------------------ *
 * 实验布局批：正文推入方向（right 从右 / bottom 从下）。
 * bottom 档整块从下方 100% 高度推上来（translateY 100% → 0），退出滑回下方。
 * 这里保持与 useUISettings 的 ArticlePushDirection 同构，但故意不反向依赖 hook。
 * ------------------------------------------------------------------ */
export type ReaderPushDirection = "right" | "bottom" | "down";

/** 推进（外层）bottom 方向 —— initial 在下方 100% */
export const PUSH_INITIAL_BOTTOM = { opacity: 1, y: "100%" } as const;
export const PUSH_ANIMATE_BOTTOM = { opacity: 1, y: 0, scale: 1 } as const;
export const PUSH_EXIT_BOTTOM = { opacity: 1, y: "100%", scale: 1 } as const;

/*
 * down 档（条目栏与正文栏合为一列，正文接在列表末尾）里正文是**文档流内联**的，
 * 不走这套整块推入；这里给它与 bottom 相同的数值，只为让类型闭合、
 * 万一被复用（例如窗口很窄时退回浮层）也有个合理默认。
 */
export function pushInitialFor(direction: ReaderPushDirection) {
  return direction === "right" ? PUSH_INITIAL : PUSH_INITIAL_BOTTOM;
}
export function pushAnimateFor(direction: ReaderPushDirection) {
  return direction === "right" ? PUSH_ANIMATE : PUSH_ANIMATE_BOTTOM;
}
export function pushExitFor(direction: ReaderPushDirection) {
  return direction === "right" ? PUSH_EXIT_WITH_ENTRY : PUSH_EXIT_BOTTOM;
}

/** 滑动（内层）的 initial/animate/exit —— 抄自 ArticleView.jsx L193（initial）L194-200（animate）L201（exit） */
export const SLIDE_INITIAL = { y: 50, opacity: 0 } as const;
/** 内层 animate 里 opacity 单独 delay 0.05 —— 抄自 ArticleView.jsx L197-199 */
export const SLIDE_ANIMATE_OPACITY_DELAY = 0.05;
export const SLIDE_ANIMATE = { y: 0, opacity: 1 } as const;
export const SLIDE_EXIT = { y: -50, opacity: 0 } as const;
