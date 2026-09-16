import { cn } from "@/lib/utils";

/** 侧栏条目 —— Nextflux 风格：胶囊圆角、行内留白更松、选中为柔和浅底 */
export const feedItemStyles = cn(
  "flex w-full cursor-pointer items-center rounded-lg pr-2.5 h-8 gap-2",
  "text-[0.8125rem] font-medium leading-loose",
  "hover:bg-item-hover transition-colors duration-200",
  "data-[active=true]:bg-item-active",
);

export const sidebarItemIconStyles = cn(
  "shrink-0 size-5 flex items-center justify-center",
);

/** 订阅源 favicon 的 Nextflux 处理：略大、圆角、带极浅投影（像贴在纸上的贴纸） */
export const feedIconImageStyles = cn(
  "size-5 rounded-[6px] object-cover",
  "shadow-[0_1px_2px_rgba(0,0,0,0.12)]",
);
