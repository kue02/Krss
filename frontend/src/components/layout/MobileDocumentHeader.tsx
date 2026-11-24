import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

interface MobileDocumentHeaderProps {
  enabled: boolean;
  headerRef: RefObject<HTMLDivElement | null>;
  testId: string;
  children: ReactNode;
  /** 阅读内联正文向下滚动时把列表顶栏收起（只留正文自己的顶栏吸顶） */
  hidden?: boolean;
}

export function MobileDocumentHeader({
  enabled,
  headerRef,
  testId,
  children,
  hidden = false,
}: MobileDocumentHeaderProps) {
  return (
    <>
      <div
        ref={headerRef}
        data-testid={testId}
        className={cn(
          enabled &&
            "fixed inset-x-0 top-0 z-20 border-b border-border/45 bg-background/88 backdrop-blur-xl transition-[transform,opacity] duration-300 ease-out",
          enabled && (hidden ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100"),
        )}
      >
        {/* Hide short WebKit compositor gaps during momentum scrolling. */}
        {enabled && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-2 -bottom-px bg-background"
          />
        )}
        <div className={cn(enabled && "relative pt-[env(safe-area-inset-top)]")}>
          {children}
        </div>
      </div>
      {enabled && (
        <div
          aria-hidden="true"
          className="h-[calc(2.75rem+env(safe-area-inset-top))]"
        />
      )}
    </>
  );
}
