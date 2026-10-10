import { useState, useCallback, useMemo, useRef } from "react";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RssIcon, ErrorIcon } from "@/components/ui/icons";
import { FeedContextMenuItems } from "@/components/feed/FeedContextMenuItems";
import { ListBox, Label, Description } from "@heroui/react";
import { useContextMenu } from "@/hooks/useContextMenu";
import { resolveFeedSiteUrl } from "@/lib/feed-site";
import { useUISettingKey } from "@/hooks/useUISettings";
import { feedItemStyles, sidebarItemIconStyles, feedIconImageStyles } from "./styles";
import type { ContentType, Folder } from "@/types/api";

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
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
};

/**
 * 12-1 续（用户实测反馈）：行内链接的点击要**同时**做两件事 ——
 * ① 打开主站（不 preventDefault，浏览器照常新标签打开）；
 * ② 切换到这个订阅（RAC 的按压被上面的 stopPropagation 挡掉了，所以要手动补一次选中）。
 * 只做①时，用户点 @源站 会「什么都不发生」（新标签可能被拦/被忽略，列表也不切），
 * 实测就是这个症状。
 */
function makeSiteLinkHandlers(href: string | undefined, onSelect?: () => void) {
  return {
    ...stopRowPress,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      onSelect?.();
      void href;
    },
  };
}

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
                      {...makeSiteLinkHandlers(siteUrlResolved ?? undefined, onClick)}
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
                {...makeSiteLinkHandlers(siteUrlResolved ?? undefined, onClick)}
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

  /**
   * 右键菜单内容：两套根共用 —— 呈现与行为都收口在共享的 `FeedContextMenuItems`
   *（卡 B：第二栏条目菜单渲染同一份）。外观/图标/文案/可用性条件一字不动，
   * 只是实现从这里搬出去。
   *
   * 注意：这里按 props 组装一个够用的 Feed 传进去（图标、类型、siteUrl 等字段齐全），
   * 「为此订阅新建规则」点开时共享组件会先从 feeds 缓存里取完整对象。
   */
  const rowMenu = (
      <ContextMenuContent>
        <FeedContextMenuItems
          feed={{
            id: feedId,
            title: name,
            url: feedUrl ?? "",
            siteUrl,
            type: "article",
            createdAt: "",
            updatedAt: "",
          }}
          folders={folders}
          label={name}
          onRefresh={onRefresh}
          onEdit={onEdit}
          onDelete={onDelete}
          onMoveToFolder={onMoveToFolder}
          onChangeType={onChangeType}
        />
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
              /**
               * 12-1（复现后定位）：ListBox 模式下只靠 RAC 的 `onAction` 会「第一次点击能切、
               * 之后再点别的订阅没反应」——埋点实测：第二、三次点击 pointerdown/up/click 都落在
               * 正确的行上，但**没有触发导航**（history.replaceState 没被调用），也就是 onAction 没再发。
               * 这里让行内容自己也能触发选中（幂等：即使 onAction 也发了，切到同一个订阅没有副作用）。
               */
              onClick={onClick}
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
