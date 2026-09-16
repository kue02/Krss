import { forwardRef, useEffect, useRef, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Star,
  Undo2,
} from "lucide-react";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/date-utils";
import { stripHtml } from "@/lib/html-utils";
import { getEntryImages } from "@/lib/extract-images";
import { useTranslationStore } from "@/stores/translation-store";
import { FeedIcon } from "@/components/ui/feed-icon";
import { useUISettingKey } from "@/hooks/useUISettings";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { useAutoReadable } from "@/hooks/useAutoReadable";
import { stripDuplicatedTitle } from "@/lib/strip-duplicated-title";
import { stripContentImages } from "@/lib/strip-content-images";
import { parseSocialSource } from "@/lib/social-source";
import { removeContentSeparators } from "@/lib/social-content";
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
  /** 社交媒体视图下：长贴默认展开（按视图设置） */
  autoExpandLong?: boolean;
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
/** 社交媒体视图里长贴折叠高度（对齐 Folo 的 collapsedHeight = 300） */
const SOCIAL_COLLAPSED_PX = 300;
const SOCIAL_COLLAPSED_HEIGHT = `${SOCIAL_COLLAPSED_PX}px`;
/** Folo 的 mask-b-2xl：只在最后 90px 做淡出 */
const SOCIAL_COLLAPSE_MASK =
  "linear-gradient(to bottom, #000 calc(100% - 90px), transparent)";

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
      autoExpandLong = false,
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
    const [isThumbLoaded, setIsThumbLoaded] = useState(false);
    // 社交媒体视图：长贴是否已手动展开（Folo 的「显示更多」）
    const [bodyExpanded, setBodyExpanded] = useState(false);
    // 展开时先动画到实测高度，动画结束后再交回 auto（对齐 Folo 的 AutoResizeHeight）
    const [expandTarget, setExpandTarget] = useState<number | null>(null);
    const { mutate: markAsRead } = useMarkAsRead();
    const { mutate: markAsStarred } = useMarkAsStarred();
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

      // 社交媒体视图用固定折叠高度判定（Folo: collapsedHeight = 300）
      const measure = () => {
        setIsContentClipped(node.scrollHeight > 300 + 8);
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
    // 源常在正文开头重复标题，时间线里标题已单独渲染，去掉重复的首段；
    // 图片也从正文摘掉，交给下面的缩略图行（对齐 Folo 的 noMedia + MediaGallery）
    const socialBody = useMemo(
      () =>
        removeContentSeparators(
          stripContentImages(
            stripDuplicatedTitle(expandedContent, displayTitle),
          ),
        ),
      [expandedContent, displayTitle],
    );
    // 社交帖常把正文开头当成标题：这时不单独渲染标题，避免同一句话出现两次
    const titleIsBodyPrefix = useMemo(() => {
      // 源的标题往往是「正文掐掉换行后的版本」：两边都去掉全部空白再比前缀，
      // 免得 stripHtml 不给 <br> 补空格导致比对失败
      const squash = (value: string) => value.replace(/\s+/g, "");
      // 源的标题常在结尾用省略号截断，比对前去掉
      const title = squash((displayTitle ?? "").replace(/(?:\.{2,}|…)\s*$/, ""));
      const raw = squash(stripHtml(entry.content ?? ""));
      if (title.length < 6 || !raw) return false;
      return raw.startsWith(title);
    }, [displayTitle, entry.content]);

    // 社交平台与作者（从条目链接解析，用于显示 @handle）
    const socialSource = useMemo(
      () => (isSocialView ? parseSocialSource(entry.url) : null),
      [isSocialView, entry.url],
    );

    // 社交媒体视图的图片行（加载失败的直接不显示，避免破图）
    const [failedThumbs, setFailedThumbs] = useState<Set<string>>(() => new Set());
    const socialImages = useMemo(
      () => getEntryImages(entry.thumbnailUrl, entry.content, entry.url),
      [entry.thumbnailUrl, entry.content, entry.url],
    );
    // 「长贴自动展开」开启后不做折叠（按视图设置，由 EntryList 传进来）
    const bodyClamped = isContentClipped && !bodyExpanded && !autoExpandLong;
    const isUnread = !entry.read;
    const isLargeImage = cardImageSize === "large";
    const showThumbnail =
      cardImageSize !== "none" && Boolean(thumbnail) && !imageError;

    // ── 社交媒体视图（对齐 Folo 的 SocialMediaItem）──────────────────────
    // 头像在左、作者行在右；正文纯文字（图片抽到下面的缩略图行）；
    // 正文超过 300px 折叠 + 遮罩淡出 + 「显示更多」；未读点在最左侧。
    if (isSocialView) {
      return (
        <div
          ref={(node) => {
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
            inViewRef.current = node;
          }}
          className={cn(
            // Folo 的社交时间线是「居中可读宽度」而不是通栏
            "group relative mx-auto mb-1 flex w-full max-w-[clamp(45ch,60vw,65ch)] cursor-pointer rounded-xl border border-transparent px-3 py-4 transition-colors duration-200",
            isSelected ? "border-border/60 bg-card shadow-nf" : "hover:bg-item-hover",
            !isUnread && !entry.starred && !isSelected && "opacity-[0.78]",
          )}
          style={style}
          data-index={dataIndex}
          data-entry-id={dataEntryId}
          onClick={onClick}
        >
          <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

          {/* 未读点：Folo 放在条目最左侧 */}
          {isUnread && (
            <span
              aria-hidden="true"
              className="absolute -left-0.5 top-8 size-2 rounded-full bg-primary"
            />
          )}

          {/* 头像式 favicon（Folo 用 32px 的源图标当作者头像） */}
          {showIcon ? (
            <img
              src={`/icons/${feed.iconPath}`}
              alt=""
              className="mt-1 size-8 shrink-0 rounded-full object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <FeedIcon className="size-4 text-muted-foreground/60" />
            </div>
          )}

          <div className="ml-2 min-w-0 flex-1">
            {/* 作者行：源名 · @handle · 时间（Folo 这里 select-none，拖选只作用于正文） */}
            <div className="flex select-none flex-wrap items-center gap-x-1 leading-6">
              <span className="truncate text-base font-semibold text-foreground">
                {displayFeedName}
              </span>
              {/* Folo 会在源名后面挂 @handle（可点进作者主页）；
                  源名里已经带同一 handle 时不重复显示 */}
              {socialSource &&
                !displayFeedName.toLowerCase().includes(
                  socialSource.handle.toLowerCase(),
                ) && (
                  <a
                    href={socialSource.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-muted-foreground transition-colors duration-200 hover:text-foreground"
                    onClick={(event) => event.stopPropagation()}
                  >
                    @{socialSource.handle}
                  </a>
                )}
              {publishedAt && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{publishedAt}</span>
                </>
              )}
              {entry.starred && (
                <Star className="ml-1 size-3.5 shrink-0 text-amber-500" />
              )}
            </div>

            {/* 标题：只有不是「正文开头」时才单独显示（对齐 Folo：社交条目以正文为主） */}
            {displayTitle && !titleIsBodyPrefix && (
              <div className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug text-foreground wrap-anywhere">
                {displayTitle}
              </div>
            )}

            {/* 正文：纯文字 + 300px 折叠（Folo 的 CollapsedSocialMediaItem） */}
            <div className="relative mt-1">
              {inView ? (
                <>
                  <div
                    ref={expandedBodyRef}
                    className={cn(
                      "entry-content prose prose-sm dark:prose-invert max-w-none break-words",
                      bodyClamped && "overflow-hidden",
                    )}
                    style={{
                      fontSize: `${Math.max(14, entryFontSize - 2)}px`,
                      lineHeight: entryLineHeight,
                      ...(readingFontStack
                        ? { fontFamily: readingFontStack }
                        : {}),
                      ...(bodyClamped
                        ? {
                            maxHeight: SOCIAL_COLLAPSED_HEIGHT,
                            overflow: "hidden",
                            maskImage: SOCIAL_COLLAPSE_MASK,
                            WebkitMaskImage: SOCIAL_COLLAPSE_MASK,
                          }
                        : {}),
                      ...(expandTarget !== null
                        ? {
                            maxHeight: `${expandTarget}px`,
                            overflow: "hidden",
                            transition:
                              "max-height 220ms cubic-bezier(0.22, 0.61, 0.36, 1)",
                          }
                        : {}),
                    }}
                    onTransitionEnd={() => setExpandTarget(null)}
                  >
                    <ArticleContent content={socialBody} articleUrl={entry.url} />
                  </div>

                  {/* 显示更多：Folo 是「纯文字 + 下箭头」压在正文底部，不是一颗胶囊按钮 */}
                  {bodyClamped && (
                    <div className="absolute inset-x-0 -bottom-2 flex select-none justify-center py-2">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          const node = expandedBodyRef.current;
                          setExpandTarget(node ? node.scrollHeight : null);
                          setBodyExpanded(true);
                        }}
                        className="flex items-center justify-center text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
                      >
                        <ChevronDown className="size-3.5" />
                        <span className="ml-2">{t("entry.show_more")}</span>
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
              )}
            </div>

            {/* 图片：正文里已摘掉，这里排成一行缩略图（Folo 的 MediaGallery） */}
            {socialImages.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {socialImages
                  .slice(0, 3)
                  .filter((url) => !failedThumbs.has(url))
                  .map((url) => (
                    <img
                      key={url}
                      src={url}
                      alt=""
                      loading="lazy"
                      className="size-28 shrink-0 rounded-lg bg-muted object-cover"
                      onError={() =>
                        setFailedThumbs((prev) => new Set(prev).add(url))
                      }
                    />
                  ))}
              </div>
            )}

            {/* 悬停操作条（对齐 Folo 的 ActionBar）：默认透明，悬停/选中时浮出 */}
            <div
              className={cn(
                "absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-overlay/90 p-1 shadow-nf backdrop-blur-sm transition-opacity duration-200",
                isSelected
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
              )}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                title={entry.starred ? t("entry.remove_from_starred") : t("entry.add_to_starred")}
                onClick={() => markAsStarred({ id: entry.id, starred: !entry.starred })}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
              >
                <Star className={cn("size-4", entry.starred && "fill-amber-500 text-amber-500")} />
              </button>
              <button
                type="button"
                title={isUnread ? t("entry.mark_read") : t("entry.mark_unread")}
                onClick={() => markAsRead({ id: entry.id, read: isUnread })}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
              >
                {isUnread ? <Check className="size-4" /> : <Undo2 className="size-4" />}
              </button>
              {entry.url && (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("entry.open_original")}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                >
                  <ExternalLink className="size-4" />
                </a>
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
              {entry.url && <span className="ml-auto">{t("entry.open_original")}</span>}
            </div>
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
          !isUnread && !entry.starred && !isSelected && "opacity-[0.78]",
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
              // Nextflux 只用 opacity 表示已读；这里标题始终是前景色，
              // 已读/未读只差字重，避免再叠一层灰导致正文难以辨认
              isUnread ? "font-semibold text-foreground" : "font-medium text-foreground",
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
              !isThumbLoaded && "animate-pulse",
              isLargeImage
                ? "h-[168px] w-full shrink-0"
                : "h-[92px] w-[92px] shrink-0 self-start",
            )}
          >
            <img
              src={thumbnail ?? ""}
              alt=""
              loading="lazy"
              className={cn(
                "size-full object-cover transition-[transform,opacity] duration-300 group-hover:scale-[1.03]",
                isThumbLoaded ? "opacity-100" : "opacity-0",
              )}
              onLoad={() => setIsThumbLoaded(true)}
              onError={() => setImageError(true)}
            />
          </div>
        )}

      </div>
    );
  },
);
