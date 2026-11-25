import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFeeds } from "@/hooks/useFeeds";
import { estimateReadingMinutes } from "@/lib/reading-time";
import type { Entry } from "@/types/api";

export function useEntryMeta(
  entry: Entry | null | undefined,
  readingContent?: string | null,
) {
  const { data: feeds } = useFeeds();
  const { t, i18n } = useTranslation();

  const longDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [i18n.language],
  );

  const shortDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [i18n.language],
  );

  const feedTitle = useMemo(() => {
    if (!entry?.feedId || !feeds) return null;
    return feeds.find((feed) => feed.id === entry.feedId)?.title ?? null;
  }, [entry, feeds]);

  const publishedAt = useMemo(() => {
    if (!entry?.publishedAt) return null;
    const date = new Date(entry.publishedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }, [entry]);

  const publishedLong = useMemo(() => {
    if (!publishedAt) return null;
    return longDateFormatter.format(publishedAt);
  }, [publishedAt, longDateFormatter]);

  const publishedShort = useMemo(() => {
    if (!publishedAt) return null;
    return shortDateFormatter.format(publishedAt);
  }, [publishedAt, shortDateFormatter]);

  const readingTime = useMemo(() => {
    const mins = estimateReadingMinutes(readingContent ?? entry?.content);
    return mins ? t("entry.min_read", { mins }) : null;
  }, [entry, readingContent, t]);

  return { feedTitle, publishedLong, publishedShort, readingTime };
}
