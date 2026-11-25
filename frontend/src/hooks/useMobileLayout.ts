import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useLocation, useSearch } from "wouter";
import { parseRoute, buildPath } from "@/lib/router";
import { useUISettingKey } from "@/hooks/useUISettings";

export type MobileView = "list" | "detail";

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1366;

/**
 * 移动端侧栏开关放在模块级 store，而不是 `useMobileLayout` 里的 useState。
 *
 * 原因（2026-11-25 移动端实测）：`useMobileLayout()` 由 AuthenticatedApp 调用，
 * `sidebarOpen` 一改就让整棵 App 树（EntryList / 详情页 / 侧栏内容）跟着重渲染，
 * 实测点菜单按钮后仍有 255ms / 197ms 的 longtask、首帧 276ms —— 而单独给面板写
 * `style.transform` 时没有任何 longtask。开关本身只是面板的一个 class 变化，
 * 不该产生 App 级 commit。现在只有订阅这里的 `<Sheet>` 会重渲染，
 * 它拿到的 children 元素对象没变，React 会直接跳过 Sidebar 子树。
 */
let mobileSidebarOpen = false;
const mobileSidebarListeners = new Set<() => void>();

function notifyMobileSidebarListeners() {
  for (const listener of mobileSidebarListeners) listener();
}

/** 改侧栏开关：只通知订阅者（Sheet），不动 App 状态 */
export function setMobileSidebarOpen(open: boolean) {
  if (mobileSidebarOpen === open) return;
  mobileSidebarOpen = open;
  notifyMobileSidebarListeners();
}

function subscribeMobileSidebar(listener: () => void) {
  mobileSidebarListeners.add(listener);
  return () => {
    mobileSidebarListeners.delete(listener);
  };
}

function getMobileSidebarSnapshot() {
  return mobileSidebarOpen;
}

/** 订阅侧栏开关；只有用到开关的组件（Sheet）才该调它 */
export function useMobileSidebarOpen() {
  return useSyncExternalStore(
    subscribeMobileSidebar,
    getMobileSidebarSnapshot,
    getMobileSidebarSnapshot,
  );
}

export function useMobileLayout() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined"
      ? window.innerWidth < MOBILE_BREAKPOINT
      : false,
  );
  const [isTablet, setIsTablet] = useState(
    typeof window !== "undefined"
      ? window.innerWidth >= MOBILE_BREAKPOINT &&
          window.innerWidth < TABLET_BREAKPOINT
      : false,
  );

  // 47-1：`?unread` 缺席时按「记住的那一档」兜底（与 useSelection 同一口径，
  // 否则移动端从详情退回列表时会把这一档写错）
  const rememberedUnreadOnly = useUISettingKey("unreadOnly");

  // Mobile view is derived from URL - if there's an entryId, show detail
  const mobileView: MobileView = useMemo(() => {
    const routeState = parseRoute(location, search, rememberedUnreadOnly);
    return routeState.entryId ? "detail" : "list";
  }, [location, search, rememberedUnreadOnly]);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < MOBILE_BREAKPOINT;
      const tablet =
        window.innerWidth >= MOBILE_BREAKPOINT &&
        window.innerWidth < TABLET_BREAKPOINT;
      setIsMobile(mobile);
      setIsTablet(tablet);
      if (!mobile) {
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Sync sidebar state on back navigation (iOS PWA swipe gesture / browser back)
  // This handles BFCache restoration and popstate events
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      // persisted = true means page was restored from BFCache
      if (e.persisted) {
        setMobileSidebarOpen(false);
      }
    };
    const handlePopState = () => {
      setMobileSidebarOpen(false);
    };

    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Navigate back to list by removing entryId from URL.
  // 用 replace 而不是 push：详情是从列表 push 上来的，返回若再 push 一条列表历史，
  // 浏览器再后退会先回到刚关掉的正文（真机反馈「右滑返回像退了一个网页」的鬼影）。
  // 大多数切视图的入口本来就该 replace，保持一致。
  const showList = useCallback(() => {
    const routeState = parseRoute(location, search, rememberedUnreadOnly);
    navigate(
      buildPath(
        routeState.selection,
        null, // Remove entryId
        routeState.unreadOnly,
        routeState.contentType,
      ),
      { replace: true },
    );
  }, [location, search, navigate, rememberedUnreadOnly]);

  const openSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  return {
    isMobile,
    isTablet,
    mobileView,
    showList,
    openSidebar,
    closeSidebar,
  };
}
