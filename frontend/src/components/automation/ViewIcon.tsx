import { Search as SearchIcon } from "lucide-react";
import { BUILTIN_VIEW_ICONS, parseViewIcon } from "@/lib/view-icon";
import { cn } from "@/lib/utils";

/**
 * 渲染视图的自定义图标（用户 11-5）：内置 lucide 图标 / emoji / 上传的图片；
 * 没设或认不出来时退回默认的筛选图标（**不渲染空白**——本项目踩过「图标白板」）。
 */
export function ViewIcon({
  icon,
  className,
}: {
  icon?: string | null;
  className?: string;
}) {
  const parsed = parseViewIcon(icon);
  const base = cn("size-4 -translate-y-px text-muted-foreground", className);

  if (parsed.kind === "builtin") {
    const Icon = BUILTIN_VIEW_ICONS[parsed.value] ?? SearchIcon;
    return <Icon className={base} />;
  }
  if (parsed.kind === "emoji") {
    return <span className={cn("text-sm leading-none", className)}>{parsed.value}</span>;
  }
  if (parsed.kind === "image") {
    return (
      <img
        src={parsed.value}
        alt=""
        className={cn("size-4 -translate-y-px rounded-[3px] object-cover", className)}
      />
    );
  }
  return <SearchIcon className={base} />;
}
