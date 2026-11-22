import type { ContentType } from "@/types/api";

/**
 * 移动端底栏「首击回顶部、再击切全部」的判定。
 *
 * 移动端列表走 document 滚动（见 useMobileDocumentScrollMode / scroll-surface），
 * 回顶部必须沿用 dispatchScrollToTop，不能直接 window.scrollTo —— 否则会绕过
 * EntryList 的 smooth 滚动与 anchor 稳定逻辑。
 */
export const MOBILE_TAB_SCROLL_TOP_THRESHOLD = 8;

/** 与 useScrollToTop 的 scope 约定一致：普通列表 entrylist，图片瀑布流 picture。 */
export type MobileTabScrollScope = "entrylist" | "picture";

export function getMobileListScrollTop(): number {
  return window.scrollY || document.documentElement.scrollTop;
}

export function isMobileListAtTop(
  threshold: number = MOBILE_TAB_SCROLL_TOP_THRESHOLD,
): boolean {
  return getMobileListScrollTop() <= threshold;
}

export function scrollScopeForType(type: ContentType): MobileTabScrollScope {
  return type === "picture" ? "picture" : "entrylist";
}

export type MobileTabTapAction = "scroll-to-top" | "select-all" | "noop";

export interface ResolveMobileTabTapInput {
  /** 点的是不是当前已激活的那个 tab */
  isActiveTab: boolean;
  hasPluginView: boolean;
  /** 当前选择是不是该内容类型的「全部」 */
  selectionIsAll: boolean;
  scrollTop: number;
  threshold?: number;
}

/**
 * - 其他 tab：原行为，切到该类型「全部」。
 * - 当前 tab 且列表已下滚（> 8px）：只回顶部，不切类型、不重置订阅范围、不退插件视图。
 * - 当前 tab 已在顶部：切到「全部」；已经是「全部」且无插件视图则什么都不做。
 */
export function resolveMobileTabTap({
  isActiveTab,
  hasPluginView,
  selectionIsAll,
  scrollTop,
  threshold = MOBILE_TAB_SCROLL_TOP_THRESHOLD,
}: ResolveMobileTabTapInput): MobileTabTapAction {
  if (!isActiveTab) return "select-all";
  if (scrollTop > threshold) return "scroll-to-top";
  if (hasPluginView) return "select-all";
  if (selectionIsAll) return "noop";
  return "select-all";
}

export interface ApplyMobileTabTapInput extends ResolveMobileTabTapInput {
  type: ContentType;
  scrollToTop: (scope: MobileTabScrollScope) => void;
  closePluginView: () => void;
  selectAll: () => void;
}

/**
 * 把判定落到副作用上：抽出来是为了在测试里用 mock 验证
 * 「已滚动时点当前 tab 只回顶部、不调用 selectAll」。
 */
export function applyMobileTabTap({
  type,
  scrollToTop,
  closePluginView,
  selectAll,
  ...input
}: ApplyMobileTabTapInput): MobileTabTapAction {
  const action = resolveMobileTabTap(input);

  if (action === "scroll-to-top") {
    scrollToTop(scrollScopeForType(type));
    return action;
  }

  if (action === "select-all") {
    if (input.hasPluginView) closePluginView();
    selectAll();
  }

  return action;
}