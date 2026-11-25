import { useInsertionEffect, useLayoutEffect, useRef } from "react";

const DOCUMENT_SCROLL_CLASS = "mobile-document-scroll";
const DOCUMENT_SCROLL_LOCKED_CLASS = "mobile-document-scroll-locked";

interface MobileDocumentScrollModeOptions {
  enabled: boolean;
  locked: boolean;
}

export function useMobileDocumentScrollMode({
  enabled,
  locked,
}: MobileDocumentScrollModeOptions): void {
  const lockedScrollY = useRef<number | null>(null);

  useInsertionEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousScrollRestoration = history.scrollRestoration;

    root.classList.toggle(DOCUMENT_SCROLL_CLASS, enabled);
    body.classList.toggle(DOCUMENT_SCROLL_CLASS, enabled);
    if (enabled) {
      // 必须是 "auto"，不能是 "manual"。
      //
      // iOS 的边缘右滑返回手势，会用「浏览器为该历史条目记录的滚动位置」来
      // 合成手势过程中滑入的那张原生快照。设为 "manual" 时浏览器什么都不记录，
      // 于是在**任何已滚动的页面**上，返回手势的整段预览都是一片空白 —— 松手、
      // 切回列表的一瞬间就闪一下空框（WebKit/iOS 专有；返回按钮走客户端
      // navigate，不经过这张快照，所以返回按钮不出问题）。
      //
      // 设 "auto" 后浏览器按条目记录/回放滚动位置，手势预览就是真实的列表内容，
      // 不再空白。列表在详情态是常驻挂载的（只是被锁住文档滚动），回放位置与
      // 我们下面 useLayoutEffect 里手动恢复的 lockedScrollY 一致，不会打架。
      // 参考：webjs #1428 真机实测（manual→空白，auto→正常）。
      history.scrollRestoration = "auto";
    }

    return () => {
      root.classList.remove(DOCUMENT_SCROLL_CLASS);
      body.classList.remove(DOCUMENT_SCROLL_CLASS);
      root.classList.remove(DOCUMENT_SCROLL_LOCKED_CLASS);
      body.classList.remove(DOCUMENT_SCROLL_LOCKED_CLASS);
      history.scrollRestoration = previousScrollRestoration;
    };
  }, [enabled]);

  useInsertionEffect(() => {
    const shouldLock = enabled && locked;
    if (shouldLock) {
      lockedScrollY.current ??= window.scrollY;
    }
    document.documentElement.classList.toggle(
      DOCUMENT_SCROLL_LOCKED_CLASS,
      shouldLock,
    );
    document.body.classList.toggle(DOCUMENT_SCROLL_LOCKED_CLASS, shouldLock);
  }, [enabled, locked]);

  useLayoutEffect(() => {
    if (!enabled) {
      lockedScrollY.current = null;
      return;
    }

    if (locked || lockedScrollY.current === null) return;
    const scrollY = lockedScrollY.current;
    lockedScrollY.current = null;
    window.scrollTo({ top: scrollY, behavior: "auto" });
  }, [enabled, locked]);
}
