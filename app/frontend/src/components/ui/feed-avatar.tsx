import { useState } from "react";
import { cn } from "@/lib/utils";
import { FeedIcon } from "./feed-icon";

interface FeedAvatarProps {
  /** 后端抓下来的图标文件名（`/icons/<iconPath>`）；没有就退成通用 RSS 图标 */
  iconPath?: string;
  /** 边长（px）。显式给 width/height 是为了让浏览器提前知道尺寸，避免图片到时撑动布局 */
  size?: number;
  /** 圆角风格：订阅行是圆角小方块，社交流是圆形头像 */
  rounded?: "square" | "circle";
  className?: string;
  alt?: string;
}

/**
 * 订阅头像 —— 有抓到的 favicon 就显示它，加载失败或没有就退成通用 RSS 图标。
 *
 * 抽出来是因为「`<img src={/icons/${iconPath}}>` + 失败兜底」这套逻辑在项目里已经出现 5 处
 * （侧栏订阅行、订阅设置、条目卡片、图片查看器、图片瀑布流），每处都自己写一遍必然出现
 * 「有的地方 lazy、有的地方没尺寸」这种漂移。新代码统一走这里；老代码按需迁移。
 */
export function FeedAvatar({
  iconPath,
  size = 20,
  rounded = "square",
  className,
  alt = "",
}: FeedAvatarProps) {
  const [failed, setFailed] = useState(false);
  /**
   * 12-18：小方块那档的圆角改由 `<html>` 上的 `--ui-icon-radius` 决定（外观里可配，默认 3px）。
   * 圆形那档（社交流头像）保持 `rounded-full` 不受设置影响 —— 它是「形状」不是「圆角」。
   */
  const isCircle = rounded === "circle";
  const radius = isCircle ? "rounded-full" : "";

  if (iconPath && !failed) {
    return (
      <img
        src={`/icons/${iconPath}`}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        data-slot="feed-avatar"
        className={cn("shrink-0 object-contain", radius, className)}
        style={{
          width: size,
          height: size,
          ...(isCircle ? null : { borderRadius: "var(--ui-icon-radius, 3px)" }),
        }}
      />
    );
  }

  return (
    <FeedIcon
      className={cn("shrink-0 text-muted-foreground", radius, className)}
      style={{
        width: size,
        height: size,
        ...(isCircle ? null : { borderRadius: "var(--ui-icon-radius, 3px)" }),
      }}
    />
  );
}
