import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useUpdateCheckStore } from "@/stores/update-check-store";

interface BackToTopButtonProps {
  scrollNode: HTMLDivElement;
  threshold?: number;
}

export function BackToTopButton({
  scrollNode,
  threshold = 300,
}: BackToTopButtonProps) {
  const [isVisible, setIsVisible] = useState(false);
  // 右下角挂着版本更新提示时让上去一层：两者都贴 right/bottom，
  // toast 是 pointer-events-auto 的实体卡片，压着就等于点不到。
  const hasUpdateToast = useUpdateCheckStore((state) => state.toastVisible);

  useEffect(() => {
    const handleScroll = () => {
      setIsVisible(scrollNode.scrollTop > threshold);
    };

    // Initial check
    handleScroll();

    scrollNode.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollNode.removeEventListener("scroll", handleScroll);
  }, [scrollNode, threshold]);

  const handleClick = () => {
    scrollNode.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "fixed right-4 bottom-[max(2.75rem,calc(env(safe-area-inset-bottom)+0.75rem))] md:right-6 z-30",
        hasUpdateToast ? "md:bottom-32" : "md:bottom-6",
        "flex size-10 items-center justify-center rounded-full",
        "bg-background/80 backdrop-blur border border-border shadow-lg",
        "text-muted-foreground hover:text-foreground hover:bg-background",
        "transition-all duration-300",
        isVisible
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-4 pointer-events-none",
      )}
      aria-label="Back to top"
    >
      <svg
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}
