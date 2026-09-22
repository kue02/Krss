import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 单行文字，装不下时悬浮滚动（跑马灯）。用户 12-16：「如果字体太长、标题太长容纳不下，
 * 就做成标题滚动的（类似跑马灯）」。
 *
 * 为什么是自写 CSS 动画：HeroUI 没有跑马灯/滚动文字组件（73 个组件里最接近的是 ScrollShadow，
 * 那是滚动阴影，不是滚动文字）—— 这里只用 HeroUI 的 token 变量做样式，动画本身是 CSS keyframes。
 * 距离要按「内容宽 - 容器宽」算，CSS 自己量不出来，所以用 ResizeObserver 量一次写进 CSS 变量。
 */
export function MarqueeText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      const inner = innerRef.current;
      if (!box || !inner) return;
      setDistance(Math.max(0, inner.scrollWidth - box.clientWidth));
    };
    measure();
    // jsdom（单测环境）没有 ResizeObserver：量不出距离就不滚动，别让测试环境炸掉
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (boxRef.current) observer.observe(boxRef.current);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={boxRef}
      className={cn("marquee block min-w-0 overflow-hidden", className)}
      title={text}
    >
      <span
        ref={innerRef}
        className={cn(
          "inline-block whitespace-nowrap",
          distance > 0 && "marquee-track",
        )}
        style={
          distance > 0
            ? ({ "--marquee-distance": `-${distance}px` } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
