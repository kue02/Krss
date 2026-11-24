import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProgressBar } from "@heroui/react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface MobilePullToRefreshProps {
  enabled: boolean;
  isRefreshing: boolean;
  onRefresh: () => Promise<void> | void;
  /** 后端刷新进度（刷新中显示「正在刷新 · 3 / 74」） */
  progressTotal?: number;
  progressCompleted?: number;
}

const PULL_THRESHOLD = 64;
const MAX_PULL = 96;

/**
 * 移动端下拉刷新。
 *
 * 列表在移动端走文档滚动（`html.mobile-document-scroll`），所以监听 window 的 touch；
 * 只在 scrollY <= 0 时接管，并给橡皮筋阻尼，松手超过 64px 才真正刷新。
 * 顶栏按钮、输入框、弹层上的手势不拦，避免误触。
 */
export function MobilePullToRefresh({
  enabled,
  isRefreshing,
  onRefresh,
  progressTotal = 0,
  progressCompleted = 0,
}: MobilePullToRefreshProps) {
  const { t } = useTranslation();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const reset = () => {
      startYRef.current = null;
      pullRef.current = 0;
      setPull(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (busy || window.scrollY > 0 || event.touches.length !== 1) {
        reset();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "button, a, input, textarea, select, [role='dialog'], [data-no-pull]",
        )
      ) {
        reset();
        return;
      }
      startYRef.current = event.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startYRef.current === null || event.touches.length !== 1) return;
      const delta = (event.touches[0]?.clientY ?? 0) - startYRef.current;
      if (delta <= 0 || window.scrollY > 0) {
        if (pullRef.current !== 0) reset();
        return;
      }
      // 阻尼：手指走 160px 时指示器大约走 80px，越拉越沉。
      const next = Math.min(MAX_PULL, Math.pow(delta, 0.86));
      pullRef.current = next;
      setPull(next);
      if (event.cancelable) event.preventDefault();
    };

    const onTouchEnd = () => {
      if (startYRef.current === null) return;
      const shouldRefresh = pullRef.current >= PULL_THRESHOLD;
      startYRef.current = null;
      if (!shouldRefresh) {
        reset();
        return;
      }
      setBusy(true);
      setPull(PULL_THRESHOLD);
      void Promise.resolve(onRefresh()).finally(() => {
        setBusy(false);
        reset();
      });
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [busy, enabled, onRefresh]);

  if (!enabled) return null;
  const active = busy || isRefreshing;
  const visible = active || pull > 0;
  const percent = active
    ? progressTotal > 0
      ? Math.min(100, (progressCompleted / progressTotal) * 100)
      : 100
    : Math.min(100, (pull / PULL_THRESHOLD) * 100);

  return createPortal(
    <div
      data-testid="pull-refresh-progress"
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-30 transition-opacity duration-150",
        visible ? "opacity-100" : "opacity-0",
      )}
      style={{ top: "calc(2.75rem + env(safe-area-inset-top))" }}
    >
      <ProgressBar
        value={percent}
        minValue={0}
        maxValue={100}
        aria-label={t("entry.refreshing")}
        className="block w-full"
      >
        <ProgressBar.Track className="h-[3px] rounded-none bg-transparent">
          <ProgressBar.Fill
            className={cn(
              "rounded-none transition-[width] duration-150",
              active && progressTotal === 0 && "animate-pulse",
            )}
          />
        </ProgressBar.Track>
      </ProgressBar>
    </div>,
    document.body,
  );
}
