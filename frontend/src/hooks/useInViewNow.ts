import { useEffect, useRef, useState } from "react";

/**
 * 元素**当前**是否在视口内——可回退版。
 *
 * 与 `useInView` 的区别：`useInView` 的语义是「曾经进入过就永远 true」（它服务于
 * 列表「自动展开正文」，那里一旦展开就不该收回）。但如果拿那个语义去控 `<video>`
 * 的 `preload`，就会变成「滚过一次就永久 auto」——离屏视频会继续高速下载，白白
 * 抢走带宽。这里改成随交叉状态实时翻转：移出视口就把 `inView` 改回 false。
 *
 * 没有 `IntersectionObserver`（jsdom / 很老的浏览器）时按「在视口内」处理，
 * 避免无法观察的环境里视频永远不预载。
 */
export function useInViewNow<T extends HTMLElement>(rootMargin = "0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState<boolean>(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    // 无 IO 的环境在初始化时就已经是 true，这里无需再 setState
    if (typeof IntersectionObserver === "undefined") return;
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}
