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
 * 组件本体用 obsidianui 的 `hover-img` 原件（`components/block/hover-img.tsx`），
 * 跟随 / 逐行切换 / 进出场都是它自己的；它自带的三处 hover 动效也原样保留。
 * 这里只做两件事：
 *  1. 把 krss 的条目映射成它的 `ProjectItem`（标题 / 来源·时间 / 图片 / 来源图标）；
 *  2. 用 `picture-hover.css` 把它的落地页尺度收成条目列表尺度（不改动效本身）。
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
          // 沿用项目里 `/icons/<iconPath>` 的取法（上游没有这个字段）
          iconSrc: feed?.iconPath ? `/icons/${feed.iconPath}` : undefined,
        };
      }),
    [items, t],
  );

  return <HoverImg projects={projects} className="krss-hover-img" />;
}

export default PictureHoverList;
