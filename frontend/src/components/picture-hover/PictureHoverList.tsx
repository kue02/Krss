import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HoverImg } from "@/components/block/hover-img";
import { getEntryImages } from "@/lib/extract-images";
import { formatRelativeTime } from "@/lib/date-utils";
import type { Entry, Feed } from "@/types/api";
import "./picture-hover.css";

interface PictureHoverListProps {
  items: { entry: Entry; feed?: Feed }[];
}

/**
 * 图片视图 · 第三种布局（hover-img）
 *
 * 直接复用 obsidianui 的 `hover-img` 组件（`components/block/hover-img.tsx`，
 * 见 https://www.obsidianui.dev/docs/hover-img）负责跟随与进出场，这里只做两件事：
 *  1. 把 krss 的条目映射成它的 `ProjectItem`（标题 / 来源·时间 / 首图）；
 *  2. 用 `picture-hover.css` 收掉它自带的落地页样式，改吃项目主题变量。
 */
export function PictureHoverList({ items }: PictureHoverListProps) {
  const { t } = useTranslation();

  const projects = useMemo(
    () =>
      items.map(({ entry, feed }) => {
        const images = getEntryImages(
          entry.thumbnailUrl,
          entry.content,
          entry.url ?? undefined,
        );
        const time = entry.publishedAt
          ? formatRelativeTime(entry.publishedAt, t)
          : "";

        return {
          title: entry.title?.trim() || "",
          label: [feed?.title, time].filter(Boolean).join(" · "),
          imageSrc: images[0] ?? "",
          // ② 行首来源图标（沿用项目里 `/icons/<iconPath>` 的取法）
          iconSrc: feed?.iconPath ? `/icons/${feed.iconPath}` : "",
          // ③ 一篇的全部图交给浮块内的左右切换
          images,
        };
      }),
    [items, t],
  );

  return <HoverImg projects={projects} className="krss-hover-img" />;
}

export default PictureHoverList;
