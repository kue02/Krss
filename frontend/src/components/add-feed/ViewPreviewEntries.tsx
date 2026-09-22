import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { EntryListItem } from "@/components/entry-list/EntryListItem";
import { PictureItem } from "@/components/picture-masonry/PictureItem";
import type {
  ContentType,
  Entry,
  Feed,
  FeedPreview,
  FeedPreviewEntry,
} from "@/types/api";

interface ViewPreviewEntriesProps {
  type: ContentType;
  feed: FeedPreview;
}

/** 试看条目上限：够看清这个视图长什么样即可 */
const PREVIEW_LIMIT = 4;

function toPreviewEntry(item: FeedPreviewEntry, index: number): Entry {
  const timestamp = item.publishedAt ?? new Date().toISOString();
  return {
    id: `feed-preview-${index}`,
    feedId: "feed-preview",
    title: item.title,
    url: item.url,
    content: item.content,
    thumbnailUrl: item.thumbnailUrl,
    author: item.author,
    publishedAt: item.publishedAt,
    read: false,
    starred: false,
    muted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 添加订阅时的「真实效果」试看（对齐 Folo 的 ViewSelectorRadioGroup）：
 * 用**真正抓到的前几条条目**、交给该视图真正的渲染组件去画，
 * 不是静态色块示意。整块设为不可交互，避免误触发出真实 API 调用。
 */
export function ViewPreviewEntries({ type, feed }: ViewPreviewEntriesProps) {
  const { t } = useTranslation();

  const entries = useMemo(
    () =>
      (feed.entries ?? [])
        .slice(0, PREVIEW_LIMIT)
        .map((item, index) => toPreviewEntry(item, index)),
    [feed.entries],
  );

  const previewFeed = useMemo<Feed>(
    () => ({
      id: "feed-preview",
      title: feed.title,
      url: feed.url,
      siteUrl: feed.siteUrl,
      description: feed.description,
      type,
      createdAt: "",
      updatedAt: "",
    }),
    [feed.description, feed.siteUrl, feed.title, feed.url, type],
  );

  // 图片视图只画有图的条目（与真正的瀑布流一致：没图不占位）
  const items = useMemo(
    () =>
      type === "picture"
        ? entries.filter((entry) => Boolean(entry.thumbnailUrl))
        : entries,
    [entries, type],
  );

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {type === "picture"
          ? t("add_feed.view_preview_no_image")
          : t("add_feed.view_preview_empty")}
      </p>
    );
  }

  return (
    <div
      aria-label={t("add_feed.view_preview_hint")}
      className="overflow-hidden rounded-xl border border-border bg-background"
    >
      <div className="pointer-events-none select-none p-2">
        {type === "picture" ? (
          <div className="grid grid-cols-3 gap-2">
            {items.map((entry) => (
              <PictureItem key={entry.id} entry={entry} />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((entry) => (
              <EntryListItem
                key={entry.id}
                entry={entry}
                feed={previewFeed}
                isSelected={false}
                onClick={() => undefined}
                social={type === "social"}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
