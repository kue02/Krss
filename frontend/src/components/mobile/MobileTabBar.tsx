import { useEffect, useMemo, useState } from "react";
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

/** 低于这个滚动位置一律算「在顶部」，此时底栏必须可见。 */
const TOP_RESET_THRESHOLD_PX = 6;
/** 方向切换后的静默期，避免惯性滚动中来回翻。 */
const DIRECTION_LOCK_MS = 300;
/** 滚动停下多久后认为手势结束，允许下一帧重新判定方向。 */
const SCROLL_SETTLE_MS = 140;
/** 触发隐藏/显示的最小位移，滤掉像素级抖动。 */
const DIRECTION_DELTA_PX = 2;

/**
 * 移动端底部内容类型导航。
 *
 * 当前移动端没有任何常驻导航：切换内容类型必须先进侧栏，搜索要从桌面快捷键进，
 * 详情页一开就只剩返回。这个底栏把四个内容类型做成常驻一级入口，
 * 44×44 以上点击区域、56px 栏高 + 底部安全区，正文区对应留出底部 padding。
 *
 * 收起逻辑有两处必须守住，否则会出现「已经在顶部、底栏还是不见」：
 * 1. 「到顶」的判定要排在方向静默期之前——静默期只用来压制方向抖动，
 *    不能把回顶事件一起吞掉，否则 300ms 内滑回顶部就再没有事件把它叫回来。
 * 2. `last` 每次滚动都要更新，不能只在非静默分支更新，否则静默期结束后的
 *    第一帧会拿陈旧基准算出巨大位移，方向直接判反。
 */
export function MobileTabBar({
  contentType,
  visibleContentTypes,
  onSelect,
}: MobileTabBarProps) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let lockUntil = 0;
    let settleTimer = 0;

    /** 到顶就无条件展开，静默期与方向都不参与判断。 */
    const revealIfAtTop = () => {
      if (window.scrollY > TOP_RESET_THRESHOLD_PX) return;
      lockUntil = 0;
      setHidden(false);
    };

    const update = () => {
      const y = window.scrollY;
      const dy = y - last;
      last = y;
      if (y <= TOP_RESET_THRESHOLD_PX) {
        lockUntil = 0;
        setHidden(false);
        return;
      }
      if (performance.now() < lockUntil) return;
      if (dy > DIRECTION_DELTA_PX) {
        setHidden(true);
        lockUntil = performance.now() + DIRECTION_LOCK_MS;
      } else if (dy < -DIRECTION_DELTA_PX) {
        setHidden(false);
        lockUntil = performance.now() + DIRECTION_LOCK_MS;
      }
    };

    // 惯性滚动停止、程序化跳转（点底栏回顶、路由回填）之后都不会再有 scroll 事件，
    // 这里补一次落地校正，把静默期清掉并按真实位置对齐显隐。
    const handleSettle = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        lockUntil = 0;
        revealIfAtTop();
      }, SCROLL_SETTLE_MS);
    };

    const onScroll = () => {
      update();
      handleSettle();
    };

    // 切内容类型、页面从缓存恢复、旋转屏幕时，滚动位置可能整体换掉且不派发 scroll。
    const syncToScrollPosition = () => {
      last = window.scrollY;
      lockUntil = 0;
      revealIfAtTop();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pageshow", syncToScrollPosition);
    window.addEventListener("resize", syncToScrollPosition);
    window.addEventListener("orientationchange", syncToScrollPosition);
    syncToScrollPosition();

    return () => {
      window.clearTimeout(settleTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pageshow", syncToScrollPosition);
      window.removeEventListener("resize", syncToScrollPosition);
      window.removeEventListener("orientationchange", syncToScrollPosition);
    };
    // 内容类型换了就是另一份列表，沿用上一份的收起状态只会让底栏凭空消失。
  }, [contentType]);

  // 兜底：收起状态下定时校正一次。有些回到顶部的路径根本不派发 scroll
  // （详情页返回时恢复滚动位置、列表重挂载、iOS 惯性滚动被系统接管），
  // 只靠事件会把底栏永远留在屏幕外。只在收起时跑，展开后立即停。
  useEffect(() => {
    if (!hidden) return;
    let timer = 0;
    const check = () => {
      if (window.scrollY <= TOP_RESET_THRESHOLD_PX) {
        setHidden(false);
        return;
      }
      timer = window.setTimeout(check, 250);
    };
    timer = window.setTimeout(check, 250);
    return () => window.clearTimeout(timer);
  }, [hidden]);

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
      data-hidden={hidden ? "true" : undefined}
      inert={hidden}
      className={cn(
        "mobile-tab-bar fixed inset-x-0 bottom-0 z-20 border-t border-border/50 bg-background/75 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgba(0,0,0,0.03)] backdrop-blur-xl transition-transform duration-300 ease-out",
        hidden ? "translate-y-full" : "translate-y-0",
      )}
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
