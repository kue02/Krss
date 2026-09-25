import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { HoverImg } from "@/components/block/hover-img";
import { getEntryImages } from "@/lib/extract-images";
import { formatRelativeTime } from "@/lib/date-utils";
import { useUISettingKey } from "@/hooks/useUISettings";
import type { Entry, Feed } from "@/types/api";
import "./picture-hover.css";

interface PictureHoverListProps {
  items: { entry: Entry; feed?: Feed }[];
  /**
   * 行点击回调（reader-transition 批新增，可选）。
   * HoverImg 上游原件的行没有 onClick，这里在适配层用事件委托补上 ——
   * 行的下标就是 items 的下标（HoverImg 按 projects 顺序渲染 `.hover-img-project`），
   * 点到行即按下标回查 entry.id。不传则与原来完全一致（纯展示，点击无反应）。
   */
  onSelectEntry?: (entryId: string) => void;
  /** 选中行的 entry id（可选）：给行加 `data-selected`，便于样式/测试定位 */
  selectedEntryId?: string | null;
  /**
   * 28-7a：行高尺度与浮块尺寸（用户 2026-09-25 要求这两项可设置）。
   * 打成根节点上的 data-* 属性，由 picture-hover.css 取值 —— 上游原件不动。
   */
  rowHeight?: "compact" | "comfortable";
  imageSize?: "small" | "large";
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
export function PictureHoverList({
  items,
  onSelectEntry,
  selectedEntryId,
  rowHeight = "compact",
  imageSize = "small",
}: PictureHoverListProps) {
  const { t } = useTranslation();
  /* 29-4：多图切换触发开关（三个独立开关，只读不改键） */
  const multiImageConfig = useUISettingKey("hoverMultiImage");

  // 28-7a：尺寸预设打成 data-* 属性，picture-hover.css 据此取值（上游原件不动）
  const sizeAttrs = {
    "data-row-height": rowHeight,
    "data-image-size": imageSize,
  } as const;

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
          /* 29-3：第一张保留做回退（单图行与原来一字一致），全部图走 imageSrcs */
          imageSrc: images[0] ?? "",
          imageSrcs: images,
          // 沿用项目里 `/icons/<iconPath>` 的取法（上游没有这个字段）
          iconSrc: feed?.iconPath ? `/icons/${feed.iconPath}` : undefined,
        };
      }),
    [items, t],
  );

  const listRef = useRef<HTMLDivElement | null>(null);

  // 选中行打标：HoverImg 行上没有 data-entry-id，这里按下标同步一份，
  // 供测试与「回到顶部」这类按 [data-entry-id] 定位的逻辑使用。
  useEffect(() => {
    if (!onSelectEntry) return;
    const node = listRef.current;
    if (!node) return;
    const rows = node.querySelectorAll(".hover-img-project");
    rows.forEach((row, index) => {
      const entry = items[index]?.entry;
      if (entry) row.setAttribute("data-entry-id", entry.id);
      else row.removeAttribute("data-entry-id");
      if (selectedEntryId && entry?.id === selectedEntryId) {
        row.setAttribute("data-selected", "true");
      } else {
        row.removeAttribute("data-selected");
      }
    });
  });

  if (!onSelectEntry) {
    return (
      <div {...sizeAttrs}>
        <HoverImg projects={projects} className="krss-hover-img" multiImageConfig={multiImageConfig} />
      </div>
    );
  }

  // 可点形态（文章视图 hover 档）：HoverImg 原件不动，在外层做事件委托。
  // 行顺序 = projects 顺序 = items 顺序，按下标回查 entry.id。
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest(".hover-img-project");
    if (!row) return;
    const container = row.parentElement;
    if (!container) return;
    const index = Array.prototype.indexOf.call(container.children, row);
    const entry = items[index]?.entry;
    if (entry) onSelectEntry(entry.id);
  };

  return (
    <div
      ref={listRef}
      onClick={handleClick}
      data-testid="hover-entry-list"
      {...sizeAttrs}
    >
      <HoverImg projects={projects} className="krss-hover-img" multiImageConfig={multiImageConfig} />
    </div>
  );
}

export default PictureHoverList;
