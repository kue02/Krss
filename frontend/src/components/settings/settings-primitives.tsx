import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 设置页的共用视觉原语（与「外观」页同一套语言）。
 *
 * 外观页里这三件套原本是文件内私有组件；数据控制 / AI 页重设计时抽到这里，
 * 让三个设置页共用同一份分区卡片、分组小标题与设置行，避免各写一套、慢慢漂移。
 * 外观页暂时保留自己的私有实现（行为零变化），后续可平滑切到这份。
 */

/** 分区卡片：图标 + 标题 + 描述 + 右侧操作，下面装设置行（纯展示，无状态） */
export function SectionCard({
  icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border/60 bg-card/30 shadow-nf-sm",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/10 text-primary">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children != null && <div className="px-3 py-1.5">{children}</div>}
    </section>
  );
}

/** 分区里的子分组小标题 */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </div>
  );
}

/** 设置行：左侧说明 + 右侧控件（DOM 契约：label 与控件同为根节点子元素） */
export function SettingRow({
  label,
  children,
  disabled = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** 该行当前不生效（如「滚动标已读」关了之后的「已读判定」）：整行变淡且不可交互 */
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 py-2.5",
        disabled && "opacity-60",
      )}
      aria-disabled={disabled || undefined}
    >
      <div className="text-sm text-foreground">
        {label}
        {hint && (
          <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-2",
          disabled && "pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}
