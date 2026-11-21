import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

interface MobileDocumentHeaderProps {
  enabled: boolean;
  headerRef: RefObject<HTMLDivElement | null>;
  testId: string;
  children: ReactNode;
}

export function MobileDocumentHeader({
  enabled,
  headerRef,
  testId,
  children,
}: MobileDocumentHeaderProps) {
  return (
    <>
      <div
        ref={headerRef}
        data-testid={testId}
        className={cn(
          enabled &&
            "fixed inset-x-0 top-0 z-20 border-b border-border/45 bg-background/88 backdrop-blur-xl",
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
