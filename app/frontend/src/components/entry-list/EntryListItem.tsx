import { forwardRef, memo, useEffect, useRef, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Clock,
  ExternalLink,
  Globe,
  Link2,
  Star,
} from "lucide-react";
import { BellOff, ShieldOff, Wand2 } from "lucide-react";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/date-utils";
import { stripHtml } from "@/lib/html-utils";
import { getEntryImages } from "@/lib/extract-images";
import { useImagePreviewStore } from "@/stores/image-preview-store";
import { useTranslationStore } from "@/stores/translation-store";
import { FeedIcon } from "@/components/ui/feed-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useUISettingKey } from "@/hooks/useUISettings";
import {
  UnreadIndicator,
  unreadRowClass,
} from "@/components/entry-list/unread-indicator";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { readToggleAction } from "@/components/entry-list/read-toggle-action";
import { useUnmuteEntry, useFilters, useCreateFilterException } from "@/hooks/useFilters";
import { showToast } from "@/stores/toast-store";
import { openFilterEditorForEntry } from "@/stores/filter-editor-store";
import { useAutoReadable } from "@/hooks/useAutoReadable";
import { stripDuplicatedTitle } from "@/lib/strip-duplicated-title";
import { stripContentImages } from "@/lib/strip-content-images";
import { parseSocialSource } from "@/lib/social-source";
import { removeContentSeparators } from "@/lib/social-content";
import { copyToClipboard } from "@/stores/toast-store";
import { useInView } from "@/hooks/useInView";
import { ArticleContent } from "@/components/ui/article-content";
import { resolveReadingFontStack } from "@/lib/reading-fonts";
import type { Entry, Feed } from "@/types/api";

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

interface EntryListItemProps {
  /** 13-3：该订阅的未读条数（未读角标选「未读数」时用；由 EntryList 从已有查询传下来，叶子组件不自己发请求） */
  feedUnreadCount?: number;
  entry: Entry;
  feed?: Feed;
  isSelected: boolean;
  /**
   * 选中回调。收 entryId 而不是闭包 —— 父级因此能传 `useCallback` 出来的稳定引用，
   * memo 才拦得住列表级状态变化带来的全量重渲染。
   */
  onClick: (entryId: string) => void;
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

/**
 * 「已静音」细标签 —— 被过滤规则静音时的标记。
 *
 * 挂在元信息行里当一个小字标签用（细边 + 2px 圆角 + 10px 字号），
 * 不做大卡片/大圆角：它只是状态说明，不是操作入口（撤销在右键菜单里）。
 * 悬停时说明是哪条规则干的（entry.filterId → 规则名），规则被删了就说清楚。
 */
function MutedBadge({ filterId }: { filterId?: string }) {
  const { t } = useTranslation();
  const { data: filters } = useFilters();
  const rule = filterId
    ? filters?.find((item) => item.id === filterId)
    : undefined;

  return (
    <span
      title={
        rule
          ? t("automation.muted_by", { name: rule.name })
          : t("automation.muted_unknown_rule")
      }
      className="shrink-0 rounded-[3px] border border-border/60 bg-secondary/40 px-1 py-px text-[10px] font-medium leading-4 text-muted-foreground"
    >
      {t("automation.muted_badge")}
    </span>
  );
}

/**
 * 条目卡片的右键菜单。
 *
 * 四条（23-2 加了第一条「标为已读 / 标为未读」）：
 *   - 「标为已读 / 标为未读」与正文工具栏、社交条目的悬停操作条**共用一份定义**
 *     （`read-toggle-action.tsx`），图标与行为三处一致；
 *   - 「取消静音」只在条目确实被静音时出现（撤销规则写上去的 muted 标记）；
 *   - 「豁免这类内容」把误伤转成一条例外规则（顺序最前 + 反向动作）并立刻放行这一条；
 *   - 「按此条新建规则」永远可用，用作者/标题片段预填条件（见 filter-editor-store）。
 *
 * 导出给通知视图的时间线卡片复用（同一套菜单，不写第二份）。
 */
export function EntryContextMenuContent({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const unmute = useUnmuteEntry();
  const exception = useCreateFilterException();
  const { mutate: markAsRead } = useMarkAsRead();
  const readAction = readToggleAction(!entry.read);

  return (
    <ContextMenuContent>
      <ContextMenuItem
        onClick={() => markAsRead({ id: entry.id, read: readAction.nextRead })}
      >
        <readAction.Icon className="size-4 shrink-0 text-muted-foreground" />
        {t(readAction.labelKey)}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {entry.muted && (
        <>
          <ContextMenuItem
            onClick={() =>
              unmute.mutate(entry.id, {
                onSuccess: () => showToast(t("automation.unmuted")),
              })
            }
          >
            <BellOff className="size-4 shrink-0 text-muted-foreground" />
            {t("automation.unmute_entry")}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem
        disabled={exception.isPending}
        onClick={() =>
          exception.mutate(entry.id, {
            onSuccess: (rule) =>
              showToast(t("automation.exception_created", { name: rule.name })),
            onError: () => showToast(t("automation.exception_failed")),
          })
        }
      >
        <ShieldOff className="size-4 shrink-0 text-muted-foreground" />
        {t("automation.exception_entry")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => openFilterEditorForEntry(entry)}>
        <Wand2 className="size-4 shrink-0 text-muted-foreground" />
        {t("automation.rule_from_entry")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export const EntryListItemBase = forwardRef<HTMLDivElement, EntryListItemProps>(
  function EntryListItem(
    {
      entry,
      feed,
      feedUnreadCount,
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
    const isSocialView = social;
    /**
     * 进入视口前多久挂载正文（社交媒体视图的正文是 `inView ? 正文 : 占位` 门控的，
     * 一挂载就可能撑开 300px 折叠高度）。
     *
     * 为什么上方留 2400px、下方只留 1200px（非对称）：
     *   - 向下滚时，新卡片在**下方**挂载，撑开不影响可见内容；
     *   - 向上滚时，卡片是在**上方**挂载的 —— 上方撑开会把可见内容整体往下推，表现为「条目跳动」
     *     （用户报的 BUG-2）。所以上方要留得足够远，让用户往回滚之前它早就挂载好了。
     * 取 2000/1000 而不是更大：够覆盖两屏的回滚距离，又不会为看不到的内容多抓正文。
     * 代价是多挂载几张卡（约 3000px 内容），换滚动不跳。
     */
    const { ref: inViewRef, inView } = useInView<HTMLDivElement>(
      "600px",
    );
    // 只在进入视口时按需抓正文，避免一次并发抓取整屏
    const autoReadable = useAutoReadable(entry, fetchReadable && inView);
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
    /**
     * 正文正文：标题重复的开头只在「标题另渲染一份」时才剥掉。
     * 反之（标题就是正文开头、标题不渲染）必须留全文 —— 否则正文被剥掉一半，
     * 引用推文那种条目就只剩底下的引文了（用户报的「只显示引文内容」）。
     */
    const socialBody = useMemo(() => {
      const base = stripContentImages(expandedContent);
      const withoutDuplicate = titleIsBodyPrefix
        ? base
        : stripDuplicatedTitle(base, displayTitle);
      return removeContentSeparators(withoutDuplicate);
    }, [expandedContent, displayTitle, titleIsBodyPrefix]);

    // 社交平台与作者（从条目链接解析，用于显示 @handle）
    const socialSource = useMemo(
      () => (isSocialView ? parseSocialSource(entry.url) : null),
      [isSocialView, entry.url],
    );

    // 社交媒体视图的图片行（加载失败的直接不显示，避免破图）
    const openImagePreview = useImagePreviewStore((state) => state.open);
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(() => new Set());
    const socialImages = useMemo(
      () => getEntryImages(entry.thumbnailUrl, entry.content, entry.url),
      [entry.thumbnailUrl, entry.content, entry.url],
    );
    // 「长贴自动展开」开启后不做折叠（按视图设置，由 EntryList 传进来）
    const bodyClamped = isContentClipped && !bodyExpanded && !autoExpandLong;
    const isUnread = !entry.read;
    /** 23-2：三处入口共用同一份「标为已读 / 标为未读」定义 */
    const readAction = readToggleAction(isUnread);
    const unreadStyle = useUISettingKey("unreadStyle");
    const isLargeImage = cardImageSize === "large";
    const showThumbnail =
      cardImageSize !== "none" && Boolean(thumbnail) && !imageError;

    // ── 社交媒体视图（对齐 Folo 的 SocialMediaItem）──────────────────────
    // 头像在左、作者行在右；正文纯文字（图片抽到下面的缩略图行）；
    // 正文超过 300px 折叠 + 遮罩淡出 + 「显示更多」；未读点在最左侧。
    if (isSocialView) {
      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
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
                unreadRowClass(isUnread, !!entry.starred, isSelected, unreadStyle),
              )}
              style={style}
              data-index={dataIndex}
              data-entry-id={dataEntryId}
              onClick={() => onClick(entry.id)}
            >
              <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

              {/* 未读点：原来是 Folo 那样画在条目最左侧的绝对定位小圆点，
                  现在只在「小圆点」样式下出现（角标 / 变灰两种样式下不出点） */}
              {unreadStyle === "dot" && isUnread && (
                <span
                  aria-hidden="true"
                  data-unread-marker="dot-abs"
                  className="absolute -left-0.5 top-8 size-2 rounded-full bg-primary"
                />
              )}

              {/* 头像式 favicon（Folo 用 32px 的源图标当作者头像）；
                  未读标记（用户 12-2）用 HeroUI Badge 挂在它左上角 */}
              <UnreadIndicator unread={isUnread} count={feedUnreadCount} className="mt-1">
                {showIcon ? (
                  <img
                    src={`/icons/${feed.iconPath}`}
                    alt=""
                    width={32}
                    height={32}
                    loading="lazy"
                    decoding="async"
                    className="size-8 shrink-0 rounded-full object-cover"
                    onError={() => setIconError(true)}
                  />
                ) : (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground/70">
                  {/* 源没给图标时，社交条目按平台给字形（Folo 这里显示作者头像） */}
                  {socialSource?.platform === "x" ? (
                    <svg
                      className="size-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                    >
                      <path d="M5 5l14 14M19 5L5 19" />
                    </svg>
                  ) : socialSource ? (
                    <Globe className="size-4" />
                  ) : (
                    <FeedIcon className="size-4" />
                  )}
                  </div>
                )}
              </UnreadIndicator>

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
                  {entry.muted && <MutedBadge filterId={entry.filterId} />}
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
                        // 卡片正文里的图片（含引文块内的）点开大图查看器。
                        // 用捕获阶段：卡片根节点自己有点击（选中条目），子元素的处理在卡片里没生效
                        onClickCapture={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.tagName !== "IMG") return;
                          event.preventDefault();
                          event.stopPropagation();
                          const src = target.getAttribute("src") ?? "";
                          const index = socialImages.findIndex((url) => url === src);
                          openImagePreview(socialImages, index >= 0 ? index : 0);
                        }}
                        className={cn(
                          "entry-card entry-content prose prose-sm dark:prose-invert max-w-none break-words [&_img]:cursor-zoom-in",
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
                    <div className="h-20 animate-pulse rounded-lg bg-secondary/40" />
                  )}
                </div>

                {/* 图片：正文里已摘掉，这里排成一行缩略图（Folo 的 MediaGallery） */}
                {socialImages.length > 0 && (
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                    {socialImages
                      .slice(0, 3)
                      .filter((url) => !failedThumbs.has(url))
                      .map((url, index) => (
                        <button
                          key={url}
                          type="button"
                          // 点缩略图开大图查看器（用户要求：卡片里也要能点开看大图）
                          onClick={(event) => {
                            event.stopPropagation();
                            openImagePreview(socialImages, index);
                          }}
                          className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg bg-secondary"
                          aria-label="查看大图"
                        >
                          <img
                            src={url}
                            alt=""
                            width={112}
                            height={112}
                            loading="lazy"
                            decoding="async"
                            className="size-28 object-cover transition-transform duration-200 hover:scale-[1.03]"
                            onError={() =>
                              setFailedThumbs((prev) => new Set(prev).add(url))
                            }
                          />
                        </button>
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
                    className="flex size-7 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                  >
                    <Star className={cn("size-4", entry.starred && "fill-amber-500 text-amber-500")} />
                  </button>
                  <button
                    type="button"
                    title={t(readAction.labelKey)}
                    onClick={() =>
                      markAsRead({ id: entry.id, read: readAction.nextRead })
                    }
                    className="flex size-7 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                  >
                    {/* 23-2：与右键菜单 / 正文工具栏同一份图标定义（描边圆 = 标未读、对勾圆 = 标已读） */}
                    <readAction.Icon className="size-4" />
                  </button>
                  {entry.url && (
                    <>
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t("entry.open_original")}
                        className="flex size-7 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                      <button
                        type="button"
                        title={t("entry.copy_link")}
                        onClick={() =>
                          void copyToClipboard(entry.url!, t("entry.copied_link"))
                        }
                        className="flex size-7 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                      >
                        <Link2 className="size-4" />
                      </button>
                    </>
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
                  {entry.url && (
                    <span className="ml-auto flex items-center gap-2">
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors duration-200 hover:text-foreground"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {t("entry.open_original")}
                      </a>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyToClipboard(entry.url!, t("entry.copied_link"));
                        }}
                        className="transition-colors duration-200 hover:text-foreground"
                      >
                        {t("entry.copy_link")}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            </div>
          </ContextMenuTrigger>
          <EntryContextMenuContent entry={entry} />
        </ContextMenu>
      );
    }

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={(node) => {
              if (typeof ref === "function") ref(node);
              else if (ref) ref.current = node;
              inViewRef.current = node;
            }}
            className={cn(
              
              // 只过渡真正会变的属性：transition-all 会让几百张卡片为「任何」属性变化做检查
              "group relative mx-2 mb-1.5 flex cursor-pointer overflow-hidden rounded-[10px] border p-2",
              "transition-[background-color,border-color,box-shadow,opacity] duration-200",
              isLargeImage ? "flex-col gap-3" : "items-stretch gap-3",
              isSelected
                ? "border-border/60 bg-card shadow-nf"
                : "border-transparent hover:bg-item-hover",
              // 对齐 Nextflux：已读且未加星标的卡片整体降透明度（只在「变灰」样式下；其余样式由 UnreadIndicator 表达）
              unreadRowClass(isUnread, !!entry.starred, isSelected, unreadStyle),
            )}
            style={style}
            data-index={dataIndex}
            data-entry-id={dataEntryId}
            onClick={() => onClick(entry.id)}
          >
            {/* Material 3 涟漪 —— 与 Nextflux 的 ArticleCard 同库同参数 */}
            <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

            {/* 左：文字区 */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* 来源行 */}
              <div
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden text-xs",
                  isUnread ? "text-muted-foreground" : "text-muted-foreground/70",
                )}
              >
                <UnreadIndicator unread={isUnread} count={feedUnreadCount}>
                  {showIcon ? (
                    <img
                      src={`/icons/${feed.iconPath}`}
                      alt=""
                      width={20}
                      height={20}
                      loading="lazy"
                      decoding="async"
                      className="size-5 shrink-0 rounded-[var(--ui-icon-radius,3px)] object-contain"
                      onError={() => setIconError(true)}
                    />
                  ) : (
                    <FeedIcon className="size-5 shrink-0 text-muted-foreground/50" />
                  )}
                </UnreadIndicator>
                <span className="block min-w-0 truncate font-bold">
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
                {entry.muted && <MutedBadge filterId={entry.filterId} />}
              </div>

              {/* 标题 */}
              <div
                className={cn(
                  "mt-1.5 text-base font-semibold leading-6 wrap-anywhere",
                  titleContainsUrl ? "line-clamp-3" : "line-clamp-2",
                  // Nextflux 只用 opacity 表示已读；这里标题始终是前景色，
                  // 已读/未读只差字重，避免再叠一层灰导致正文难以辨认
                  // 已读 / 未读**不切字重**（对齐 Nextflux 的 ArticleCard：字体恒为 font-semibold，只用颜色区分）。
                  // 原来读态切 font-medium：字重一变，同一条标题的换行就变，1 行 ↔ 2 行切换会改卡片高度，
                  // 滚动时「标记已读」就会让整个列表跳一下（用户报的 BUG-2）。
                  isUnread ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {displayTitle || fallbackTitle}
              </div>

              {/* 摘要（行数可在 设置 → 外观 里调，0 = 不显示） */}
              {displaySummary && cardPreviewLines > 0 && !isExpanded && (
                <div
                  className={cn(
                    "mt-1 text-sm leading-relaxed text-muted-foreground wrap-anywhere",
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
                <div className="mt-auto flex items-center gap-1 pt-2 text-xs text-muted-foreground/80">
                  <Clock className="size-3 shrink-0" />
                  <span className="line-clamp-1">{readingTime}</span>
                </div>
              )}
            </div>

            {/* 缩略图：小图贴右，大图铺在正文下方 */}
            {showThumbnail && (
              <div
                className={cn(
                  "overflow-hidden rounded-lg bg-secondary",
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
                  decoding="async"
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
        </ContextMenuTrigger>
        <EntryContextMenuContent entry={entry} />
      </ContextMenu>
    );
  },
);

/**
 * 用 memo 包一层。
 *
 * 列表里动辄几百张卡片，每张卡都挂着若干 hook、图片与动效。此前父级每次状态变化
 * （选中条目、切筛选、翻译进度）都会重渲染**所有**卡片。父级已把选中回调
 * （handleSelectEntry，useCallback）与 feedsMap 查表结果做成稳定引用，
 * 卡片自己的内部状态（图片加载、展开）不受影响，所以浅比较就够。
 */
export const EntryListItem = memo(EntryListItemBase);

