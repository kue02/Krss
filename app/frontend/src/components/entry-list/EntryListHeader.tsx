import { useTranslation } from "react-i18next";
import {
  CircleOutlineIcon,
  CircleFilledIcon,
  CheckCircleIcon,
  MenuIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { dispatchScrollToTop } from "@/hooks/useScrollToTop";

interface EntryListHeaderProps {
  title: string;
  unreadCount: number;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onMarkAllRead: () => void;
  /** 刷新当前选中范围（文件夹 / 单个源 / 某个视图） */
  onRefresh?: () => void;
  isRefreshing?: boolean;
  scrollToTopScope?: string;
  isMobile?: boolean;
  onMenuClick?: () => void;
  isTablet?: boolean;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
}

export function EntryListHeader({
  title,
  unreadCount,
  unreadOnly,
  onToggleUnreadOnly,
  onMarkAllRead,
  onRefresh,
  isRefreshing = false,
  scrollToTopScope,
  isMobile,
  onMenuClick,
  isTablet,
  onToggleSidebar,
  sidebarVisible,
}: EntryListHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-14 items-center justify-between gap-4 px-4 shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMobile && onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="flex size-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-item-hover -ml-1.5"
          >
            <MenuIcon className="size-5" />
          </button>
        )}
        {isTablet && onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title={
              sidebarVisible
                ? t("actions.hide_sidebar")
                : t("actions.show_sidebar")
            }
            className="flex size-11 shrink-0 items-center justify-center rounded-md transition-all duration-200 ease-[var(--ease-ios)] hover:bg-item-hover active:scale-95 -ml-1.5"
          >
            <MenuIcon className="size-5" />
          </button>
        )}
        <div className="min-w-0">
          <h2
            className="truncate text-[0.9375rem] font-bold leading-tight cursor-pointer active:opacity-70 transition-opacity"
            onClick={() => dispatchScrollToTop(scrollToTopScope)}
          >
            {title}
          </h2>
          {unreadCount > 0 && (
            <span className="block truncate text-xs text-muted-foreground">
              {t("entry.unread_count", { count: unreadCount })}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleUnreadOnly}
          title={unreadOnly ? t("entry.show_all") : t("entry.show_unread_only")}
          className="flex size-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
        >
          {unreadOnly ? (
            <CircleFilledIcon className="size-5" />
          ) : (
            <CircleOutlineIcon className="size-5" />
          )}
        </button>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title={t("entry.refresh_view")}
            disabled={isRefreshing}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-item-hover disabled:opacity-60"
          >
            <RefreshIcon className={cn("size-4", isRefreshing && "animate-spin")} />
          </button>
        )}
        <button
          type="button"
          onClick={onMarkAllRead}
          title={t("entry.mark_all_read")}
          className="flex size-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
        >
          <CheckCircleIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
