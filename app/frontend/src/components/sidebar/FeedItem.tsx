import { useState, useCallback, useMemo, useRef } from "react";
import { Ripple } from "m3-ripple";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BoltIcon, RssIcon, ErrorIcon } from "@/components/ui/icons";
import { CONTENT_TYPE_ORDER, contentTypeMeta } from "@/lib/content-type-meta";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import {
  Copy,
  ExternalLink,
  FolderInput,
  Globe,
  Pencil,
  RefreshCw,
  Tags,
  Trash2,
} from "lucide-react";
import { ListBox, Label, Description } from "@heroui/react";
import { useContextMenu } from "@/hooks/useContextMenu";
import { resolveFeedSiteUrl } from "@/lib/feed-site";
import { useUISettingKey } from "@/hooks/useUISettings";
import { copyToClipboard } from "@/stores/toast-store";
import { queryClient } from "@/lib/queryClient";
import { openFilterEditorForFeed } from "@/stores/filter-editor-store";
import { feedItemStyles, sidebarItemIconStyles, feedIconImageStyles } from "./styles";
import type { ContentType, Feed, Folder } from "@/types/api";

interface FeedItemProps {
  name: string;
  feedId: string;
  /** 订阅地址，用于右键菜单里的「复制 Feed 地址」 */
  feedUrl?: string;
  /** 订阅主页地址（RSS 元数据里的 site_url）；为空时由 feedUrl 反解（见 lib/feed-site） */
  siteUrl?: string;
  /**
   * 作为 HeroUI `ListBox.Item` 渲染（用户 11-12「名称 + @源站」外观用）。
   * 为什么不能只把外层 div 换掉：RAC 的集合要求**项是 ListBox 的直接子元素**，
   * 而默认结构里每一项外面套着 Radix 的 ContextMenu 触发器 —— 所以 ListBox 模式下
   * 根就是 `ListBox.Item`，把 ContextMenu 触发器挪到项内部包住内容。
   */
  asListBoxItem?: boolean;
  iconPath?: string;
  unreadCount?: number;
  isActive?: boolean;
  errorMessage?: string;
  onClick?: () => void;
  className?: string;
  folders?: Folder[];
  onRefresh?: (feedId: string) => void;
  onEdit?: (feedId: string) => void;
  onDelete?: (feedId: string) => void;
  onMoveToFolder?: (feedId: string, folderId: string | null) => void;
  onChangeType?: (feedId: string, type: ContentType) => void;
}

/**
 * 12-1：让行内链接「真能点」。
 *
 * 两层原因（12-1 实测定位）：
 *  ① HeroUI 的 `Description` 自带 `pointer-events: none`（集合项里的文字不抢指针事件）
 *     → 锚点**永远点不到**，所以要给链接本身加 `pointer-events-auto`；
 *  ② 行根是 RAC 的 `ListBox.Item`，它对 pointerdown/pointerup 做按压处理（按下即 preventDefault）
 *     → 锚点的原生跳转会被吃掉。所以指针事件上 stopPropagation（**不是** preventDefault）：
 *     既让 RAC 收不到这次按压，又不影响浏览器自己的跳转与中键/右键；click/keydown 一并挡住，
 *     避免顺带切换订阅。
 */
const stopRowPress = {
  onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  onPointerUp: (event: React.PointerEvent) => event.stopPropagation(),
  onClick: (event: React.MouseEvent) => event.stopPropagation(),
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
};

export function FeedItem({
  name,
  feedId,
  feedUrl,
  siteUrl,
  asListBoxItem = false,
  iconPath,
  unreadCount,
  isActive = false,
  errorMessage,
  onClick,
  className,
  folders = [],
  onRefresh,
  onEdit,
  onDelete,
  onMoveToFolder,
  onChangeType,
}: FeedItemProps) {
  const { t } = useTranslation();
  // 「前往主站 / 复制主站地址」用（11-11）：优先订阅元数据，其次从 RSSHub 路由反解；都没有就藏起这两项
  const siteUrlResolved = useMemo(
    () => resolveFeedSiteUrl({ siteUrl, url: feedUrl }),
    [siteUrl, feedUrl],
  );
  const [iconError, setIconError] = useState(false);
  // 第一栏订阅外观（用户 11-12）：「名称 + @源站」时把主站域名挂在名字后面，悬浮/点击直接去主页
  const feedAppearance = useUISettingKey("sidebarFeedAppearance");
  const siteHost = useMemo(() => {
    if (feedAppearance !== "name_and_site" || !siteUrlResolved) return null;
    try {
      return new URL(siteUrlResolved).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }, [feedAppearance, siteUrlResolved]);
  const hasError = !!errorMessage;
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent | { pageX: number; pageY: number }) => {
      // Programmatically trigger the context menu for long press
      if (!("button" in e) && triggerRef.current) {
        triggerRef.current.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: e.pageX,
            clientY: e.pageY,
          }),
        );
      }
    },
    [],
  );

  const contextMenuProps = useContextMenu({
    onContextMenu: handleContextMenu,
  });

  /**
   * 「为此订阅新建规则」：打开规则编辑器抽屉并预填 scope = 这个订阅。
   *
   * 编辑器只用到 feed.id / feed.title（见 stores/filter-editor-store），而 Sidebar 传下来的是
   * 拆开的 name / feedId / feedUrl，所以先从 feeds 缓存里取完整对象（图标、类型等字段齐全），
   * 缓存里还没有这个订阅时再按 props 组装一个够用的。
   */
  const handleNewRuleFromFeed = useCallback(() => {
    const cached = queryClient
      .getQueryData<Feed[]>(["feeds"])
      ?.find((feed) => feed.id === feedId);

    openFilterEditorForFeed(
      cached ?? {
        id: feedId,
        title: name,
        url: feedUrl ?? "",
        type: "article",
        createdAt: "",
        updatedAt: "",
      },
    );
  }, [feedId, feedUrl, name]);

  /** 行内容（图标 + 名称/源站 + 错误提示 + 未读数）：两套根共用 */
  const rowContent = (
    <>
          <div
            className={cn(
              // gap-2：与分组行/内容类型行一致，图标和名称之间留 8px（原来贴在一起）
              "flex min-w-0 items-center gap-2",
              hasError && "text-red-500 dark:text-red-400",
            )}
          >
            <span className={sidebarItemIconStyles}>
              {iconPath && !iconError ? (
                <img
                  src={`/icons/${iconPath}`}
                  alt=""
                  className={feedIconImageStyles}
                  onError={() => setIconError(true)}
                />
              ) : (
                // 无图标时占位图标要与 favicon 同尺寸（16px），否则这一行的名称会比其他行偏一点
                <RssIcon className="size-4 text-muted-foreground" />
              )}
            </span>
            {/* 订阅名；「名称 + @源站」外观下把主站域名挂在后面（用户 11-12），
                悬浮变色、点击直接开主页，点它不要连带选中这个订阅（stopPropagation） */}
            {asListBoxItem ? (
              <span className="flex min-w-0 flex-col items-start">
                <Label className="max-w-full truncate text-[0.8125rem] leading-4 font-medium">
                  {name}
                </Label>
                {siteHost && (
                  <Description className="max-w-full truncate text-[0.7rem]">
                    <a
                      href={siteUrlResolved ?? undefined}
                      title={siteUrlResolved ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      {...stopRowPress}
                      /* HeroUI 的 Description（data-slot=description）带 `pointer-events: none`
                         —— 集合项内的文字默认不抢指针事件，锚点因此永远点不到（12-1 的真根因）。
                         这里只给链接本身放行，不动全局 CSS。 */
                      className="pointer-events-auto hover:text-foreground hover:underline"
                    >
                      @{siteHost}
                    </a>
                  </Description>
                )}
              </span>
            ) : (
              <span className="min-w-0 truncate">{name}</span>
            )}
            {!asListBoxItem && siteHost && (
              <a
                href={siteUrlResolved ?? undefined}
                title={siteUrlResolved ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                {...stopRowPress}
                className="pointer-events-auto shrink-0 truncate text-[0.7rem] text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
              >
                @{siteHost}
              </a>
            )}
            {hasError && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-1 flex shrink-0 cursor-default">
                    <ErrorIcon className="size-3.5 text-red-500" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">{errorMessage}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {unreadCount !== undefined && unreadCount > 0 && (
            <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
              {unreadCount}
            </span>
          )}
    </>
  );

  /** 右键菜单内容：两套根共用 */
  const rowMenu = (
      <ContextMenuContent>
        {/* 标题行：说清这是「哪个订阅」的菜单 —— Nextflux 的右键菜单顶部也有这么一行，
            这里额外带上 favicon（用户要求：弹出框要有标题、项要有图标） */}
        <ContextMenuLabel className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
          <FeedAvatar iconPath={iconPath} size={16} rounded="circle" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {onRefresh && (
          <ContextMenuItem onClick={() => onRefresh(feedId)}>
            <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.refresh")}
          </ContextMenuItem>
        )}
        {onEdit && (
          <ContextMenuItem onClick={() => onEdit(feedId)}>
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.edit")}
          </ContextMenuItem>
        )}
        {onMoveToFolder && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.move_to_folder")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => onMoveToFolder(feedId, null)}>
                <FolderInput className="size-4 shrink-0 text-muted-foreground" />
                {t("actions.no_folder")}
              </ContextMenuItem>
              {folders.map((folder) => (
                <ContextMenuItem
                  key={folder.id}
                  onClick={() => onMoveToFolder(feedId, folder.id)}
                >
                  {folder.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {onChangeType && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Tags className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.change_type")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {/* 每个类型带自己的视图图标（与中栏切换器同一套映射，11-6） */}
              {CONTENT_TYPE_ORDER.map((type) => {
                const { icon: Icon, labelKey } = contentTypeMeta[type];
                return (
                  <ContextMenuItem
                    key={type}
                    onClick={() => onChangeType(feedId, type)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    {t(labelKey)}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {feedUrl && (
          <ContextMenuItem
            onClick={() => {
              void copyToClipboard(feedUrl, t("actions.copied_feed_url"));
            }}
          >
            <Copy className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.copy_feed_url")}
          </ContextMenuItem>
        )}
        {/* 主站（用户 11-11）：能拿到主页地址才显示，拿不到就藏起来，不给假地址 */}
        {siteUrlResolved && (
          <>
            <ContextMenuItem
              onClick={() => {
                window.open(siteUrlResolved, "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.open_site")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                void copyToClipboard(siteUrlResolved, t("actions.copied_site_url"));
              }}
            >
              <Globe className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.copy_site_url")}
            </ContextMenuItem>
          </>
        )}
        {/* 规则入口与上面的订阅操作同组；删除是破坏性操作，仍单独分组压在下面 */}
        <ContextMenuItem onClick={handleNewRuleFromFeed}>
          <BoltIcon className="size-4 shrink-0 text-muted-foreground" />
          {t("automation.rule_from_feed")}
        </ContextMenuItem>
        {onDelete && (
          <>
            {/* 删除是破坏性操作：单独一组，避免误点 */}
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(feedId)}
            >
              <Trash2 className="size-4 shrink-0" />
              {t("actions.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
  );

  if (asListBoxItem) {
    return (
      <ListBox.Item
        id={feedId}
        textValue={name}
        data-active={isActive}
        className={cn("group", hasError && "text-red-500 dark:text-red-400", className)}
        {...contextMenuProps}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span
              ref={triggerRef}
              className="flex w-full min-w-0 items-center justify-between gap-2"
            >
              {rowContent}
            </span>
          </ContextMenuTrigger>
          {rowMenu}
        </ContextMenu>
      </ListBox.Item>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild ref={triggerRef}>
        <div
          data-active={isActive}
          className={cn(
            feedItemStyles,
            "group relative justify-between py-0.5 pr-2",
            className,
          )}
          onClick={onClick}
          {...contextMenuProps}
        >
          <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />
          <div
            className={cn(
              // gap-2：与分组行/内容类型行一致，图标和名称之间留 8px（原来贴在一起）
              "flex min-w-0 items-center gap-2",
              hasError && "text-red-500 dark:text-red-400",
            )}
          >
            <span className={sidebarItemIconStyles}>
              {iconPath && !iconError ? (
                <img
                  src={`/icons/${iconPath}`}
                  alt=""
                  className={feedIconImageStyles}
                  onError={() => setIconError(true)}
                />
              ) : (
                // 无图标时占位图标要与 favicon 同尺寸（16px），否则这一行的名称会比其他行偏一点
                <RssIcon className="size-4 text-muted-foreground" />
              )}
            </span>
            {/* 订阅名；「名称 + @源站」外观下把主站域名挂在后面（用户 11-12），
                悬浮变色、点击直接开主页，点它不要连带选中这个订阅（stopPropagation） */}
            <span className="min-w-0 truncate">{name}</span>
            {siteHost && (
              <a
                href={siteUrlResolved ?? undefined}
                title={siteUrlResolved ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="shrink-0 truncate text-[0.7rem] text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
              >
                @{siteHost}
              </a>
            )}
            {hasError && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-1 flex shrink-0 cursor-default">
                    <ErrorIcon className="size-3.5 text-red-500" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">{errorMessage}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {unreadCount !== undefined && unreadCount > 0 && (
            <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
              {unreadCount}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      {rowMenu}
    </ContextMenu>
  );
}
