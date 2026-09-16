import { forwardRef, useEffect, useRef, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Star } from "lucide-react";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/date-utils";
import { stripHtml } from "@/lib/html-utils";
import { getEntryImages } from "@/lib/extract-images";
import { useTranslationStore } from "@/stores/translation-store";
import { FeedIcon } from "@/components/ui/feed-icon";
import { useUISettingKey } from "@/hooks/useUISettings";
import { useAutoReadable } from "@/hooks/useAutoReadable";
import { stripDuplicatedTitle } from "@/lib/strip-duplicated-title";
import { useInView } from "@/hooks/useInView";
import { ArticleContent } from "@/components/ui/article-content";
import { resolveReadingFontStack } from "@/lib/reading-fonts";
import type { Entry, Feed } from "@/types/api";

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

interface EntryListItemProps {
  entry: Entry;
  feed?: Feed;
  isSelected: boolean;
  onClick: () => void;
  autoTranslate?: boolean;
  targetLanguage?: string;
  /** 社交媒体视图（第四类内容）：时间线式铺开正文，而不是卡片列表 */
  social?: boolean;
  /** 社交媒体视图下：正文过短时自动抓正文（按视图设置） */
  fetchReadable?: boolean;
  style?: React.CSSProperties;
  "data-index"?: number;
  "data-entry-id"?: string;
}

/**
 * 文章列表卡片 —— Nextflux 样式
 *
 * 视觉要点（对齐 Nextflux 的 ArticleCard）：
 *   - 圆角卡片 + 选中时浮起（柔影 shadow-nf），未选中时无边框
 *   - 右侧方形缩略图（无图则整块隐藏，不占位）
 *   - 未读 = 深色粗体标题，已读 = 整体降透明度
 *   - 顶部来源行（favicon + 源名 + 相对时间）、底部阅读时长
 */
export const EntryListItem = forwardRef<HTMLDivElement, EntryListItemProps>(
  function EntryListItem(
    {
      entry,
      feed,
      isSelected,
      onClick,
      autoTranslate,
      targetLanguage,
      social = false,
      fetchReadable = false,
      style,
      "data-index": dataIndex,
      "data-entry-id": dataEntryId,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const publishedAt = entry.publishedAt
      ? formatRelativeTime(entry.publishedAt, t)
      : null;
    const [iconError, setIconError] = useState(false);
    const [imageError, setImageError] = useState(false);
    const showIcon = feed?.iconPath && !iconError;
    const fallbackTitle = t("entry.untitled");
    const fallbackFeedName = t("entry.unknown_feed");
    const cardImageSize = useUISettingKey("cardImageSize");
    const cardPreviewLines = useUISettingKey("cardPreviewLines");
    const entryFontFamily = useUISettingKey("entryFontFamily");
    const entryFontSize = useUISettingKey("entryFontSize");
    const entryLineHeight = useUISettingKey("entryLineHeight");

    const translation = useTranslationStore((state) =>
      autoTranslate && targetLanguage
        ? state.getTranslation(entry.id, targetLanguage)
        : undefined,
    );

    const strippedContent = useMemo(
      () => (entry.content ? stripHtml(entry.content).slice(0, 150) : null),
      [entry.content],
    );

    /** 缩略图：优先 thumbnailUrl，其次正文首图（都走图片代理） */
    const thumbnail = useMemo(() => {
      const images = getEntryImages(entry.thumbnailUrl, entry.content, entry.url);
      return images[0] ?? null;
    }, [entry.thumbnailUrl, entry.content, entry.url]);

    /** 阅读时长（与 EntryContentBody 同口径） */
    const readingTime = useMemo(() => {
      if (!entry.content) return null;
      const text = entry.content.replace(/<[^>]*>/g, "");
      const words = text.match(/[\u4e00-\u9fa5]|\w+/g)?.length || 0;
      const mins = Math.ceil(words / 230);
      return mins > 0 ? t("entry.min_read", { mins }) : null;
    }, [entry.content, t]);

    const displayTitle = translation?.title ?? entry.title;
    const displaySummary = translation?.summary ?? strippedContent;
    const displayFeedName = feed?.title || fallbackFeedName;
    const titleContainsUrl = URL_PATTERN.test(displayTitle ?? "");
    const summaryContainsUrl = URL_PATTERN.test(displaySummary ?? "");
    const { ref: inViewRef, inView } = useInView<HTMLDivElement>("600px");
    const isSocialView = social;
    // 只在社交媒体视图 + 进入视口时按需抓正文，避免一次并发抓取整屏
    const autoReadable = useAutoReadable(
      entry,
      isSocialView && fetchReadable && inView,
    );
    const expandedBodyRef = useRef<HTMLDivElement | null>(null);
    const [isContentClipped, setIsContentClipped] = useState(false);

    // 展开的正文超过上限高度时，给出渐隐 + 提示（卡片整体可点，点开进阅读区）
    useEffect(() => {
      const node = expandedBodyRef.current;
      if (!node) return;

      const measure = () => {
        setIsContentClipped(node.scrollHeight > node.clientHeight + 8);
      };

      measure();
      // 正文里的图片是异步加载的：加载完高度才定，必须复测
      const retry = setTimeout(measure, 400);
      node.addEventListener("load", measure, true);
      return () => {
        clearTimeout(retry);
        node.removeEventListener("load", measure, true);
      };
    }, [inView, entry.id, cardImageSize]);
    const readingFontStack = resolveReadingFontStack(entryFontFamily);
    const expandedContent = autoReadable ?? entry.content ?? null;
    const isExpanded = isSocialView && Boolean(expandedContent);
    // 源常在正文开头重复标题，时间线里标题已单独渲染，去掉重复的首段
    const socialBody = useMemo(
      () => stripDuplicatedTitle(expandedContent, displayTitle),
      [expandedContent, displayTitle],
    );
    const isUnread = !entry.read;
    const isLargeImage = cardImageSize === "large";
    const showThumbnail =
      cardImageSize !== "none" && Boolean(thumbnail) && !imageError;

    // ── 社交媒体视图（Folo 式时间线）：不在卡片上加展开，而是另一种呈现 ──
    if (isSocialView) {
      return (
        <div
          ref={(node) => {
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
            inViewRef.current = node;
          }}
          className={cn(
            "group relative mx-2 mb-1 cursor-pointer overflow-hidden rounded-xl border px-3 py-3 transition-colors duration-200",
            isSelected
              ? "border-border/60 bg-card shadow-nf"
              : "border-transparent hover:bg-item-hover",
            !isUnread && !entry.starred && !isSelected && "opacity-70",
          )}
          style={style}
          data-index={dataIndex}
          data-entry-id={dataEntryId}
          onClick={onClick}
        >
          <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

          {/* 来源行：头像式 favicon + 源名 + 时间（Folo 把订阅源当作者） */}
          <div className="flex min-w-0 items-center gap-2">
            {showIcon ? (
              <img
                src={`/icons/${feed.iconPath}`}
                alt=""
                className="size-6 shrink-0 rounded-full object-cover"
                onError={() => setIconError(true)}
              />
            ) : (
              <FeedIcon className="size-6 shrink-0 text-muted-foreground/50" />
            )}
            <div className="min-w-0">
              <div
                className={cn(
                  "truncate text-[13px] leading-tight",
                  isUnread
                    ? "font-semibold text-foreground"
                    : "font-medium text-muted-foreground",
                )}
              >
                {displayFeedName}
              </div>
              {publishedAt && (
                <div className="text-[11px] leading-tight text-muted-foreground/80">
                  {publishedAt}
                </div>
              )}
            </div>
            {isUnread && (
              <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
            )}
          </div>

          {/* 标题：社交帖常常没有标题，有才渲染 */}
          {displayTitle && (
            <div
              className={cn(
                "mt-2 font-semibold text-foreground wrap-anywhere",
                "text-[15px] leading-snug",
                titleContainsUrl ? "line-clamp-3" : "line-clamp-2",
              )}
            >
              {displayTitle}
            </div>
          )}

          {/* 正文：直接铺开（长文限高 + 渐隐提示） */}
          <div className="relative mt-2">
            {inView ? (
              <div
                ref={expandedBodyRef}
                className="entry-content prose prose-sm dark:prose-invert max-h-[26rem] max-w-none overflow-hidden break-words prose-img:my-3 prose-img:rounded-lg prose-a:break-words"
                style={{
                  fontSize: `${Math.max(14, entryFontSize - 2)}px`,
                  lineHeight: entryLineHeight,
                  ...(readingFontStack ? { fontFamily: readingFontStack } : {}),
                  contentVisibility: "auto",
                  containIntrinsicSize: "400px",
                }}
              >
                <ArticleContent content={socialBody} articleUrl={entry.url} />
              </div>
            ) : (
              <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
            )}

            {isContentClipped && inView && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-card via-card/70 to-transparent pb-0.5">
                <span className="rounded-full bg-overlay/85 px-2.5 py-0.5 text-[11px] font-medium text-foreground/80 shadow-sm backdrop-blur-sm">
                  {t("entry.expand_hint")}
                </span>
              </div>
            )}
          </div>

          {/* 底部元信息 */}
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            {readingTime && (
              <span className="flex items-center gap-1">
                <Clock className="size-3 shrink-0" />
                {readingTime}
              </span>
            )}
            {entry.starred && <Star className="size-3.5 text-amber-500" />}
            {entry.url && (
              <span className="ml-auto">{t("entry.open_original")}</span>
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={(node) => {
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
          inViewRef.current = node;
        }}
        className={cn(
          "group relative mx-2 mb-1.5 flex cursor-pointer overflow-hidden rounded-xl border p-3 transition-all duration-200",
          isLargeImage ? "flex-col gap-3" : "items-stretch gap-3",
          isSelected
            ? "border-border/60 bg-card shadow-nf"
            : "border-transparent hover:bg-item-hover",
          // 对齐 Nextflux：已读且未加星标的卡片整体降透明度
          !isUnread && !entry.starred && !isSelected && "opacity-70",
        )}
        style={style}
        data-index={dataIndex}
        data-entry-id={dataEntryId}
        onClick={onClick}
      >
        {/* Material 3 涟漪 —— 与 Nextflux 的 ArticleCard 同库同参数 */}
        <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

        {/* 左：文字区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 来源行 */}
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px]",
              isUnread ? "text-muted-foreground" : "text-muted-foreground/70",
            )}
          >
            {showIcon ? (
              <img
                src={`/icons/${feed.iconPath}`}
                alt=""
                className="size-4 shrink-0 rounded object-contain"
                onError={() => setIconError(true)}
              />
            ) : (
              <FeedIcon className="size-4 shrink-0 text-muted-foreground/50" />
            )}
            <span className="block min-w-0 truncate font-medium">
              {displayFeedName}
            </span>
            {publishedAt && (
              <>
                <span className="shrink-0 text-muted-foreground/40">·</span>
                <span className="shrink-0 whitespace-nowrap">
                  {publishedAt}
                </span>
              </>
            )}
          </div>

          {/* 标题 */}
          <div
            className={cn(
              "mt-1.5 text-[15px] leading-snug wrap-anywhere",
              titleContainsUrl ? "line-clamp-3" : "line-clamp-2",
              isUnread
                ? "font-semibold text-foreground"
                : "font-medium text-muted-foreground",
            )}
          >
            {displayTitle || fallbackTitle}
          </div>

          {/* 摘要（行数可在 设置 → 外观 里调，0 = 不显示） */}
          {displaySummary && cardPreviewLines > 0 && !isExpanded && (
            <div
              className={cn(
                "mt-1 text-[13px] leading-relaxed text-muted-foreground wrap-anywhere",
                !isUnread && "text-muted-foreground/70",
              )}
              style={{
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp:
                  cardPreviewLines + (summaryContainsUrl ? 1 : 0),
                overflow: "hidden",
              }}
            >
              {displaySummary}
            </div>
          )}

          {/* 阅读时长（沉底） */}
          {readingTime && (
            <div className="mt-auto flex items-center gap-1 pt-2 text-[11px] text-muted-foreground/80">
              <Clock className="size-3 shrink-0" />
              <span className="line-clamp-1">{readingTime}</span>
            </div>
          )}
        </div>

        {/* 缩略图：小图贴右，大图铺在正文下方 */}
        {showThumbnail && (
          <div
            className={cn(
              "overflow-hidden rounded-lg bg-muted",
              isLargeImage ? "h-[168px] w-full shrink-0" : "h-[92px] w-[92px] shrink-0 self-start",
            )}
          >
            <img
              src={thumbnail ?? ""}
              alt=""
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              onError={() => setImageError(true)}
            />
          </div>
        )}

      </div>
    );
  },
);
