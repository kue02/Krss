import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useFeeds } from "@/hooks/useFeeds";
import { useUnreadCounts } from "@/hooks/useEntries";
import {
  CONTENT_TYPE_ORDER,
  contentTypeMeta,
} from "@/lib/content-type-meta";
import type { ContentType } from "@/types/api";

interface MobileTabBarProps {
  contentType: ContentType;
  visibleContentTypes: ContentType[];
  onSelect: (type: ContentType) => void;
}

/**
 * 移动端底部内容类型导航。
 *
 * 当前移动端没有任何常驻导航：切换内容类型必须先进侧栏，搜索要从桌面快捷键进，
 * 详情页一开就只剩返回。这个底栏把四个内容类型做成常驻一级入口，
 * 44×44 以上点击区域、56px 栏高 + 底部安全区，正文区对应留出底部 padding。
 */
export function MobileTabBar({
  contentType,
  visibleContentTypes,
  onSelect,
}: MobileTabBarProps) {
  const { t } = useTranslation();
  const { data: feeds } = useFeeds();
  const { data: unreadCountsData } = useUnreadCounts();

  const counts = useMemo(() => {
    const total: Record<ContentType, number> = {
      article: 0,
      picture: 0,
      notification: 0,
      social: 0,
    };
    const unread = unreadCountsData?.counts ?? {};
    for (const feed of feeds ?? []) {
      total[feed.type] += unread[feed.id] ?? 0;
    }
    return total;
  }, [feeds, unreadCountsData]);

  const tabs = CONTENT_TYPE_ORDER.filter((type) =>
    visibleContentTypes.includes(type),
  );

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label={t("content_type.nav_label")}
      className="mobile-tab-bar fixed inset-x-0 bottom-0 z-20 border-t border-border/60 bg-overlay/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgba(0,0,0,0.03)] backdrop-blur-xl"
    >
      <div role="tablist" className="mx-auto flex h-14 w-full max-w-md items-stretch">
        {tabs.map((type) => {
          const meta = contentTypeMeta[type];
          const Icon = meta.icon;
          const active = contentType === type;
          const count = counts[type] ?? 0;
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(type)}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 outline-none transition-colors duration-200 active:scale-[0.96]",
                active ? "text-accent" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-200",
                  active && "bg-accent/12",
                )}
              >
                <Icon className="size-[21px]" />
              </span>
              {count > 0 ? (
                <span
                  className={cn(
                    "absolute right-1.5 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none tabular-nums",
                    active
                      ? "bg-accent text-white"
                      : "bg-default text-muted-foreground",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
              <span className="max-w-full truncate px-1 text-[10px] font-semibold leading-3">
                {t(meta.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
