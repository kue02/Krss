import { cn } from "@/lib/utils";

/** 侧栏条目 —— Nextflux 风格：胶囊圆角、行内留白更松、选中为柔和浅底 */
export const feedItemStyles = cn(
  // 对齐 Nextflux 的菜单行：h-8 / rounded-xl(≈10px) / p-2 / gap-2 / text-sm
  "flex w-full cursor-pointer items-center rounded-[10px] px-2 h-8 gap-2",
  "text-sm font-medium leading-4",
  "hover:bg-item-hover transition-colors duration-200",
  "data-[active=true]:bg-item-active",
);

export const sidebarItemIconStyles = cn(
  "shrink-0 size-4 flex items-center justify-center",
);

/**
 * 订阅源 favicon 的 Nextflux 处理：略大、圆角、带极浅投影（像贴在纸上的贴纸）。
 * 12-18：圆角改读 `--ui-icon-radius`（外观 → 形状 →「订阅图标圆角」），默认仍是量出来的 4px。
 */
export const feedIconImageStyles = cn(
  "size-4 rounded-[var(--ui-icon-radius,4px)] object-cover",
  "shadow-[0_1px_2px_rgba(0,0,0,0.12)]",
);
