import { useEffect, useRef, useState } from "react";

/**
 * 元素是否进入过视口（进入后保持 true，避免来回卸载重渲染）。
 *
 * 用途：列表「自动展开正文」时，只给靠近视口的卡片渲染完整正文，
 * 否则一屏几十篇全文会把首屏拖垮。
 */
export function useInView<T extends HTMLElement>(rootMargin = "600px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}
