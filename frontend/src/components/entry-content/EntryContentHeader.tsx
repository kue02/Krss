import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ExternalLink,
  FileText,
  Globe,
  Globe2,
  Languages,
  Lightbulb,
  MoreHorizontal,
  Sparkles,
  Star,
  Type,
  X,
} from "lucide-react";
import { isSafeUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import { BackIcon, GlobeIcon } from "@/components/ui/icons";
import { readToggleAction } from "@/components/entry-list/read-toggle-action";
import { dispatchScrollToTop } from "@/hooks/useScrollToTop";
import { useUISettingKey } from "@/hooks/useUISettings";
import {
  normalizeEntryToolbar,
  type EntryToolbarItemId,
} from "@/lib/entry-toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PluginSlot, PluginItem } from "@/plugins/PluginSlot";
import { useTargetOps } from "@/plugins/useTargetOps";
import {
  MobileActionSheet,
  MobileActionSheetItem,
} from "@/components/mobile/MobileActionSheet";
import { MobileReadingSettings } from "@/components/mobile/MobileReadingSettings";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeUsage } from "@/components/entry-list/machine-translated-badge";
import type { Entry } from "@/types/api";

interface EntryContentHeaderProps {
  entry: Entry;
  displayTitle?: string | null;
  isAtTop: boolean;
  isReadableActive: boolean;
  isLoading: boolean;
  error: string | null;
  onToggleReadable: () => void;
  onToggleStarred: () => void;
  /** 23-2：「标为已读 / 标为未读」（图标与右键菜单、社交悬停条共用一份定义） */
  onToggleRead?: () => void;
  isLoadingSummary?: boolean;
  hasSummary?: boolean;
  onToggleSummary?: () => void;
  /** REQ3：AI 摘要失败时的错误（有值则摘要按钮转红并显示原因）。 */
  summaryError?: string | null;
  isTranslating?: boolean;
  hasTranslation?: boolean;
  translationDisabled?: boolean;
  onToggleTranslation?: () => void;
  /** REQ3：翻译失败时的错误（有值则翻译按钮转红并显示原因）。 */
  translationError?: string | null;
  /** 问题③：摘要实际使用的服务/提供商/模型，用于顶栏 Tooltip（与列表徽章同口径）。 */
  summaryUsage?: { service?: string; provider?: string; model?: string } | null;
  /** 问题③：翻译实际使用的服务/提供商/模型，用于顶栏 Tooltip（与列表徽章同口径）。 */
  translationUsage?: { service?: string; provider?: string; model?: string } | null;
  isMobile?: boolean;
  onBack?: () => void;
  /**
   * 28-5：桌面第三栏（正文区）左上角的关闭按钮。
   * 移动端已有 onBack（返回列表），桌面此前只能按 Esc 关 —— 用户要求正文左上角
   * 有一颗可见的关闭按钮。只传 onClose 时不渲染 onBack 那颗，避免两颗重复。
   */
  onClose?: () => void;
  /** 是否正在阅读栏里加载原站（#13） */
  isOriginalSiteActive?: boolean;
  onToggleOriginalSite?: () => void;
  /**
   * 39-1：**内嵌模式**。第三栏那套是 `absolute inset-x-0 top-0` 盖在面板上；
   * 内嵌在时间线展开容器里时，工具栏必须跟着宿主容器一起滚（`sticky top-0`），
   * 否则展开容器一滚，工具栏就跟着正文滚走了、按钮点不到。
   */
  sticky?: boolean;
  /** sticky 时距视口顶部的偏移（手机内联合列要避让列表的固定顶栏）。默认 top-0 */
  stickyTopClassName?: string;
  /** 手机内联合列：正文标题栏吸顶（列表 TOP 栏滚走时贴在视口顶），未滚走时自然排在它下面 */
  mobileInlineSticky?: boolean;
  /**
   * 顶栏背景层是否叠加 `backdrop-blur`。默认跟随 `sticky`：第三栏那套（非内嵌）保留模糊；
   * 内联合列（卡片式正文 pane）里必须关掉：Chromium 下带 backdrop-filter 的元素
   * 不受祖先 `overflow: clip` 圆角裁剪的约束，会把卡片的圆角盖成直角（用户 2026-11-24 报的
   * 「滑动后点开正文，卡片左上角缺一块」，不滚动时背景层 opacity-0 所以看不到）。
   */
  backgroundBlur?: boolean;
}

interface TranslationButtonState {
  isDisabled: boolean;
  isTranslating: boolean;
  hasTranslation: boolean;
}

function getTranslationButtonTitle(
  state: TranslationButtonState,
  t: (key: string) => string,
): string {
  if (state.isDisabled && !state.hasTranslation && !state.isTranslating) {
    return t("entry.already_target_language");
  }
  if (state.isTranslating) {
    return t("entry.cancel_translation");
  }
  if (state.hasTranslation) {
    return t("entry.show_original");
  }
  return t("entry.translate_article");
}

function getTranslationButtonClassName(state: TranslationButtonState): string {
  if (state.isDisabled && !state.hasTranslation && !state.isTranslating) {
    return "text-muted-foreground/50 cursor-not-allowed";
  }
  if (state.hasTranslation && !state.isTranslating) {
    return "bg-item-active text-foreground";
  }
  return "text-muted-foreground hover:bg-item-hover hover:text-foreground";
}

export function EntryContentHeader({
  entry,
  displayTitle,
  isAtTop,
  isReadableActive,
  isLoading,
  error,
  onToggleReadable,
  onToggleStarred,
  onToggleRead,
  isLoadingSummary,
  hasSummary,
  onToggleSummary,
  summaryError,
  isTranslating,
  hasTranslation,
  translationDisabled,
  onToggleTranslation,
  translationError,
  summaryUsage,
  translationUsage,
  isMobile,
  onBack,
  onClose,
  isOriginalSiteActive = false,
  onToggleOriginalSite,
  sticky = false,
  stickyTopClassName,
  mobileInlineSticky = false,
  backgroundBlur = !sticky,
}: EntryContentHeaderProps) {
  const { t } = useTranslation();
  const safeUrl = entry.url && isSafeUrl(entry.url) ? entry.url : null;
  const title = displayTitle ?? entry.title ?? t("entry.untitled");
  /** 23-2：「标为已读 / 标为未读」——与条目右键菜单、社交悬停操作条同一份定义 */
  const readAction = readToggleAction(!entry.read);
  /** 56-16：本挂点上插件对宿主控件的 patch（当前只登记了星标这一个可替换控件） */
  const targetOps = useTargetOps("entry.reader.toolbar");
  const starReplacement = targetOps.replacement("entry.star");
  const starHidden = targetOps.isHidden("entry.star");
  const [moreOpen, setMoreOpen] = useState(false);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);

  if (isMobile) {
    return (
      <>
        <div
          className={cn(
            /* 手机内联合列：标题栏放回正常文档流（relative），跟着正文一起滚。
               absolute 会浮在正文顶上、吸顶又会压住列表的固定顶栏 —— 两者都不合适。 */
            sticky
              ? mobileInlineSticky
                ? "sticky top-0 z-30"
                : "relative z-20"
              : "absolute inset-x-0 top-0 z-20",
          )}
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-0 border-b border-foreground/10 bg-overlay/80 backdrop-blur-xl transition-opacity duration-300 ease-in-out",
              mobileInlineSticky ? "opacity-100" : isAtTop ? "opacity-0" : "opacity-100",
            )}
          />
          <div className="relative pt-[env(safe-area-inset-top)]">
            <div className="flex h-11 items-center gap-1 px-1.5">
              <button
                type="button"
                onClick={onClose ?? onBack}
                aria-label={onClose ? t("actions.close") : t("actions.back")}
                className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover"
              >
                {onClose ? (
                  <X className="size-5" />
                ) : (
                  <BackIcon className="size-5" />
                )}
              </button>

              <div
                className={cn(
                  "min-w-0 flex-1 px-1 transition-all duration-300 ease-out",
                  /* 内联合列时正文标题栏就是这一屏的标题，滚到顶部也一直显示（用户 2026-11-24） */
                  mobileInlineSticky || !isAtTop
                    ? "translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-1 opacity-0",
                )}
                onClick={() => dispatchScrollToTop("entrycontent")}
              >
                <div className="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground active:opacity-60">
                  {title}
                </div>
              </div>

              {starReplacement ? (
                <PluginItem
                  item={starReplacement}
                  selection={{ entryIds: [entry.id] }}
                  variant="toolbar"
                />
              ) : starHidden ? null : (
                <button
                  type="button"
                  onClick={onToggleStarred}
                  aria-label={
                    entry.starred
                      ? t("entry.remove_from_starred")
                      : t("entry.add_to_starred")
                  }
                  className={cn(
                    // 与 Web 端正文工具栏一致：未收藏为灰色（非前景色），收藏为琥珀色
                    "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors active:bg-item-hover",
                    entry.starred ? "text-amber-500" : "text-muted-foreground",
                  )}
                >
                  <svg
                    className="size-5"
                    viewBox="0 0 24 24"
                    fill={entry.starred ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    />
                  </svg>
                </button>
              )}

              {onToggleRead ? (
                <button
                  type="button"
                  onClick={onToggleRead}
                  aria-label={t(readAction.labelKey)}
                  className={cn(
                    // 与 Web 端一致：未读态给柔和强调底（bg-item-active）+ 前景色，已读态仅灰色
                    "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors active:bg-item-hover",
                    entry.read
                      ? "text-muted-foreground"
                      : "bg-item-active text-foreground",
                  )}
                >
                  <readAction.Icon className="size-5" />
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-label={t("actions.more")}
                className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover"
              >
                <MoreHorizontal className="size-5" />
              </button>
            </div>
          </div>
        </div>

        <MobileActionSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          title={title}
        >
          {onToggleRead ? (
            <MobileActionSheetItem
              icon={<readAction.Icon className="size-5" />}
              label={t(readAction.labelKey)}
              selected={!entry.read}
              onClick={() => {
                setMoreOpen(false);
                onToggleRead();
              }}
            />
          ) : null}
          {onToggleSummary ? (
            <MobileActionSheetItem
              icon={<Sparkles className="size-5" />}
              label={
                isLoadingSummary
                  ? t("entry.cancel_summary")
                  : hasSummary
                    ? t("entry.hide_summary")
                    : t("entry.generate_summary")
              }
              selected={Boolean(hasSummary)}
              onClick={() => {
                setMoreOpen(false);
                onToggleSummary();
              }}
            />
          ) : null}
          {onToggleTranslation ? (
            <MobileActionSheetItem
              icon={<Languages className="size-5" />}
              label={getTranslationButtonTitle(
                {
                  isDisabled: !!translationDisabled,
                  isTranslating: !!isTranslating,
                  hasTranslation: !!hasTranslation,
                },
                t,
              )}
              selected={Boolean(hasTranslation)}
              disabled={
                translationDisabled && !hasTranslation && !isTranslating
              }
              onClick={() => {
                setMoreOpen(false);
                onToggleTranslation();
              }}
            />
          ) : null}
          {entry.url && onToggleOriginalSite ? (
            <MobileActionSheetItem
              icon={<Globe2 className="size-5" />}
              label={
                isOriginalSiteActive
                  ? t("entry.show_readable")
                  : t("entry.original_site")
              }
              selected={isOriginalSiteActive}
              onClick={() => {
                setMoreOpen(false);
                onToggleOriginalSite();
              }}
            />
          ) : null}
          {entry.url ? (
            <MobileActionSheetItem
              icon={<FileText className="size-5" />}
              label={
                error
                  ? t("entry.show_original")
                  : isReadableActive
                    ? t("entry.show_original")
                    : t("entry.show_readable")
              }
              description={error ?? undefined}
              selected={isReadableActive}
              disabled={isLoading}
              onClick={() => {
                setMoreOpen(false);
                onToggleReadable();
              }}
            />
          ) : null}
          <MobileActionSheetItem
            icon={<Type className="size-5" />}
            label={t("entry.reading_settings")}
            onClick={() => {
              setMoreOpen(false);
              setReadingSettingsOpen(true);
            }}
          />
          {safeUrl ? (
            <MobileActionSheetItem
              icon={<ExternalLink className="size-5" />}
              label={t("entry.open_original")}
              onClick={() => {
                setMoreOpen(false);
                window.open(safeUrl, "_blank", "noopener,noreferrer");
              }}
            />
          ) : null}
          <div className="border-t border-border/50 px-4 py-2">
            <PluginSlot
              surface="entry.reader.toolbar"
              variant="toolbar"
              selection={{ entryIds: [entry.id] }}
            />
          </div>
        </MobileActionSheet>

        <MobileReadingSettings
          open={readingSettingsOpen}
          onOpenChange={setReadingSettingsOpen}
        />
      </>
    );
  }

  // 正文工具栏自定义顺序 / 显隐（REQ1）：读取归一后的配置，按它渲染。
  const entryToolbarConfig = useUISettingKey("entryToolbar");
  const toolbarItems = useMemo(
    () => normalizeEntryToolbar(entryToolbarConfig),
    [entryToolbarConfig],
  );

  const translationButtonState: TranslationButtonState = {
    isDisabled: !!translationDisabled,
    isTranslating: !!isTranslating,
    hasTranslation: !!hasTranslation,
  };
  // REQ3：失败态优先转红；正在翻译时不显示失败态（错误会在成功/取消时清掉）。
  const translationFailed = !!translationError && !isTranslating;
  const summaryFailed = !!summaryError && !isLoadingSummary;

  // 各按钮的 title / 可用性（内联按钮与「更多」菜单共用一份文案，避免两处漂移）。
  const starTitle = entry.starred
    ? t("entry.remove_from_starred")
    : t("entry.add_to_starred");
  const summaryTitle =
    summaryError && !isLoadingSummary
      ? summaryError
      : isLoadingSummary
        ? t("entry.cancel_summary")
        : hasSummary
          ? t("entry.hide_summary")
          : t("entry.generate_summary");
  const translationTitle = translationFailed
    ? (translationError as string)
    : getTranslationButtonTitle(translationButtonState, t);
  // 问题③：顶栏按钮的悬浮 Tooltip 文案 —— 与列表徽章同口径：
  // 失败→错误原因；进行中→「翻译中/摘要翻译中」；完成→provider · model / service；
  // 无元数据时退回到按钮原本的动作文案。
  const summaryTooltip = summaryFailed
    ? (summaryError as string)
    : isLoadingSummary
      ? t("entry.summary_translating")
      : hasSummary
        ? (describeUsage(summaryUsage ?? {}) ?? summaryTitle)
        : t("entry.generate_summary");
  const translationTooltip = translationFailed
    ? (translationError as string)
    : isTranslating
      ? t("entry.translating")
      : hasTranslation
        ? (describeUsage(translationUsage ?? {}) ?? translationTitle)
        : getTranslationButtonTitle(translationButtonState, t);
  const originalsiteTitle = isOriginalSiteActive
    ? t("entry.show_readable")
    : t("entry.original_site");
  const readableTitle =
    error ||
    (isReadableActive ? t("entry.show_original") : t("entry.show_readable"));

  /**
   * 「更多」（三点）菜单里的单项：与内联按钮同一套点击 / 禁用 / 失败红字逻辑，
   * 但换成带文案的菜单行（图标 + 标题），供不常驻工具栏的按钮使用。
   * 返回 null = 当前没有对应回调 / 数据，不占菜单项。
   */
  const renderToolbarMenuItem = (itemId: EntryToolbarItemId) => {
    const itemClass = "gap-2";
    switch (itemId) {
      case "star":
        // 星标被插件替换时由插件接管整颗控件，不进「更多」。
        if (starReplacement || starHidden) return null;
        return (
          <DropdownMenuItem className={itemClass} onSelect={() => onToggleStarred()}>
            <Star className="size-4 shrink-0" aria-hidden="true" />
            <span>{starTitle}</span>
          </DropdownMenuItem>
        );
      case "read":
        if (!onToggleRead) return null;
        return (
          <DropdownMenuItem className={itemClass} onSelect={() => onToggleRead()}>
            <readAction.Icon className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(readAction.labelKey)}</span>
          </DropdownMenuItem>
        );
      case "summary":
        if (!onToggleSummary) return null;
        return (
          <DropdownMenuItem
            className={cn(itemClass, summaryFailed && "text-destructive focus:text-destructive")}
            onSelect={() => onToggleSummary()}
          >
            <Lightbulb className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{summaryTitle}</span>
          </DropdownMenuItem>
        );
      case "translate":
        if (!onToggleTranslation) return null;
        return (
          <DropdownMenuItem
            className={cn(itemClass, translationFailed && "text-destructive focus:text-destructive")}
            disabled={
              translationDisabled && !hasTranslation && !isTranslating
            }
            onSelect={() => onToggleTranslation()}
          >
            <Languages className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{translationTitle}</span>
          </DropdownMenuItem>
        );
      case "originalsite":
        if (!entry.url || !onToggleOriginalSite) return null;
        return (
          <DropdownMenuItem className={itemClass} onSelect={() => onToggleOriginalSite()}>
            <Globe className="size-4 shrink-0" aria-hidden="true" />
            <span>{originalsiteTitle}</span>
          </DropdownMenuItem>
        );
      case "readable":
        if (!entry.url) return null;
        return (
          <DropdownMenuItem
            className={cn(itemClass, error && "text-destructive focus:text-destructive")}
            disabled={isLoading}
            onSelect={() => onToggleReadable()}
          >
            <FileText className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{readableTitle}</span>
          </DropdownMenuItem>
        );
      case "openexternal":
        if (!safeUrl) return null;
        return (
          <DropdownMenuItem
            className={itemClass}
            onSelect={() =>
              window.open(safeUrl, "_blank", "noopener,noreferrer")
            }
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            <span>{t("entry.open_original")}</span>
          </DropdownMenuItem>
        );
      default:
        return null;
    }
  };

  /**
   * 按 id 渲染单个工具栏按钮；判定「没有对应回调 / 数据」时返回 null（不占位）。
   * 每个按钮的尺寸 / 图标 / title / class 逻辑保持原样，只是改成可被顺序驱动。
   */
  const renderToolbarItem = (itemId: EntryToolbarItemId) => {
    switch (itemId) {
      case "star":
        // 56-16：星标可由插件替换 / 隐藏；配置里也隐藏时同样不渲染。
        if (starReplacement) {
          return (
            <PluginItem
              item={starReplacement}
              selection={{ entryIds: [entry.id] }}
              variant="toolbar"
            />
          );
        }
        if (starHidden) return null;
        return (
          <button
            type="button"
            onClick={onToggleStarred}
            title={
              entry.starred
                ? t("entry.remove_from_starred")
                : t("entry.add_to_starred")
            }
            className={cn(
              "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95",
              entry.starred
                ? "text-amber-500 hover:bg-amber-500/10"
                : "text-muted-foreground hover:bg-item-hover hover:text-foreground",
            )}
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill={entry.starred ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              />
            </svg>
          </button>
        );

      case "read":
        if (!onToggleRead) return null;
        return (
          <button
            type="button"
            onClick={onToggleRead}
            title={t(readAction.labelKey)}
            className={cn(
              "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95",
              entry.read
                ? "text-muted-foreground hover:bg-item-hover hover:text-foreground"
                : "bg-item-active text-foreground",
            )}
          >
            <readAction.Icon className="size-5" />
          </button>
        );

      case "summary":
        if (!onToggleSummary) return null;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleSummary}
                aria-label={summaryTooltip}
                className={cn(
                  "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95",
                  summaryFailed
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : hasSummary
                      ? "bg-item-active text-foreground"
                      : "text-muted-foreground hover:bg-item-hover hover:text-foreground",
                )}
              >
                <span
                  className={cn(isLoadingSummary && "ai-icon-thinking-wrapper")}
                >
                  <svg
                    className="size-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{summaryTooltip}</TooltipContent>
          </Tooltip>
        );

      case "translate":
        if (!onToggleTranslation) return null;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleTranslation}
                disabled={
                  translationDisabled && !hasTranslation && !isTranslating
                }
                aria-label={translationTooltip}
                className={cn(
                  "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95",
                  translationFailed
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : getTranslationButtonClassName(translationButtonState),
                )}
              >
                <span
                  className={cn(isTranslating && "ai-icon-thinking-wrapper")}
                >
                  <svg
                    className="size-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                    />
                  </svg>
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{translationTooltip}</TooltipContent>
          </Tooltip>
        );

      case "originalsite":
        if (!entry.url || !onToggleOriginalSite) return null;
        return (
          <button
            type="button"
            onClick={onToggleOriginalSite}
            title={
              isOriginalSiteActive
                ? t("entry.show_readable")
                : t("entry.original_site")
            }
            className={cn(
              "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95",
              isOriginalSiteActive
                ? "bg-item-active text-foreground"
                : "text-muted-foreground hover:bg-item-hover hover:text-foreground",
            )}
          >
            <GlobeIcon className="size-5" />
          </button>
        );

      case "readable":
        if (!entry.url) return null;
        return (
          <button
            type="button"
            onClick={onToggleReadable}
            disabled={isLoading}
            title={
              error ||
              (isReadableActive
                ? t("entry.show_original")
                : t("entry.show_readable"))
            }
            className={cn(
              "no-drag-region flex size-9 items-center justify-center rounded-full transition-colors duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
              error
                ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                : isReadableActive
                  ? "bg-item-active text-foreground"
                  : "text-muted-foreground hover:bg-item-hover hover:text-foreground",
            )}
          >
            <svg
              className={cn("size-5", isLoading && "animate-spin")}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              {isLoading ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              )}
            </svg>
          </button>
        );

      case "openexternal":
        if (!safeUrl) return null;
        return (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="no-drag-region flex size-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors hover:bg-item-hover hover:text-foreground"
            aria-label={t("entry.open_original")}
          >
            <svg
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        );

      default:
        return null;
    }
  };

  // 「更多」菜单的内容：按配置顺序，过滤掉当前不可用的项。
  const moreMenuItems = toolbarItems
    .filter((item) => item.placement === "more")
    .map((item) => ({ id: item.id, node: renderToolbarMenuItem(item.id) }))
    .filter((entry) => entry.node !== null)
    .map((entry) => <Fragment key={entry.id}>{entry.node}</Fragment>);

  return (
    <div
      className={cn(
        sticky
          ? cn("sticky z-20", stickyTopClassName ?? "top-0")
          : "absolute inset-x-0 top-0 z-20",
      )}
    >
      {/* Background and Border Layer */}
      {/* 对齐 Nextflux ActionButtons：70% 底 + 小 blur + 细边框，无 mask 渐隐（48px 高的条加渐隐会把按钮下半截切淡） */}
      <div
        className={cn(
          "absolute inset-0 transition-opacity duration-300 ease-in-out pointer-events-none border-b border-foreground/10 bg-overlay/70",
          backgroundBlur && "backdrop-blur-sm",
          isAtTop ? "opacity-0" : "opacity-100",
        )}
      />

      {/* Content Layer */}
      <div className="relative flex h-12 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {(onClose || onBack) && (
            <button
              type="button"
              onClick={onClose ?? onBack}
              // 与同排其它按钮同尺寸（36px / 图标 20px）；之前是 44px，看着比旁边一圈都大。
              // 注意不要用负 margin：按钮会探出头部容器左边，被后面的面板压住一半（用户截图）
              title={onClose ? t("actions.close") : t("actions.back")}
              aria-label={onClose ? t("actions.close") : t("actions.back")}
              className="no-drag-region flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground active:scale-95"
            >
              {onClose ? (
                <X className="size-5" />
              ) : (
                <BackIcon className="size-5" />
              )}
            </button>
          )}
          <div
            className={cn(
              "truncate text-base font-bold text-foreground transition-all duration-300 ease-in-out",
              isAtTop
                ? "translate-y-4 opacity-0 pointer-events-none"
                : "translate-y-0 opacity-100 cursor-pointer active:opacity-70",
            )}
            onClick={
              isAtTop ? undefined : () => dispatchScrollToTop("entrycontent")
            }
          >
            {title}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {toolbarItems.map((item) =>
            item.placement === "toolbar" ? (
              <Fragment key={item.id}>{renderToolbarItem(item.id)}</Fragment>
            ) : null,
          )}

          {/* REQ1：「更多」（三点）——收进这里的不常驻工具栏，但仍在一步可达；
              永久隐藏（placement: "hidden"）的连这里也不进。为后续插件/新按钮扩容。 */}
          {moreMenuItems.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("entry.more_actions")}
                  aria-label={t("entry.more_actions")}
                  className="no-drag-region flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground active:scale-95"
                >
                  <MoreHorizontal className="size-5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {moreMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* 56-15：阅读器工具栏的插件挂点（`entry.reader.toolbar`）。选中态就是
              正在读的这一条；`Entry.id` 本来就是字符串，不经过 `Number()`（56-12 口径）。 */}
          <PluginSlot
            surface="entry.reader.toolbar"
            variant="toolbar"
            selection={{ entryIds: [entry.id] }}
          />
        </div>
      </div>
    </div>
  );
}
