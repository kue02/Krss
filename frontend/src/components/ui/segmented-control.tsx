import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
  /** 个别选项禁用（如「只保留匹配」开着时不能选「静音」——那等于全静音） */
  disabledValues?: T[];
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  disabledValues,
}: SegmentedControlProps<T>) {
  const id = React.useId();

  return (
    <div
      role="tablist"
      className={cn(
        // 容器与滑块的取值对齐 Nextflux 的 segment 令牌（亮色为白、暗色为其指定的蓝灰）
        "flex h-8 items-center rounded-full border border-border/60 bg-secondary/40 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const isActive = value === option.value;
        const isDisabled = Boolean(disabledValues?.includes(option.value));
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            onClick={() => {
              if (isDisabled) return;
              onValueChange(option.value);
            }}
            className={cn(
              "relative flex h-6 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              isDisabled &&
                "cursor-not-allowed text-muted-foreground/50 hover:text-muted-foreground/50",
            )}
            data-state={isActive ? "active" : "inactive"}
          >
            <span className="z-[1] flex items-center gap-1.5">
              {option.label}
            </span>
            {isActive && (
              <motion.span
                layoutId={id}
                className="absolute inset-0 z-0 rounded-full bg-[var(--segment)] shadow-nf-sm"
                transition={{
                  // Nextflux 的分段滑块是短促的位移，不用慢弹簧
                  type: "spring",
                  stiffness: 520,
                  damping: 40,
                  mass: 0.7,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
