import { useCallback, useEffect, useRef, useState } from "react";
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
/** 方向判定所需的最小位移（px）：未达到前不拉进度条、不 preventDefault */
const DIRECTION_LOCK_DISTANCE = 8;
/** 纵向位移需超过横向的这个倍数才认定是下拉，其余一律视为横向并放弃本次手势 */
const DIRECTION_LOCK_RATIO = 1.2;

type PullDirection = "undetermined" | "vertical" | "ignored";

/**
 * 移动端下拉刷新。
 *
 * 列表在移动端走文档滚动（`html.mobile-document-scroll`），所以监听 window 的 touch；
 * 只在 scrollY <= 0 时接管，并给橡皮筋阻尼，松手超过 64px 才真正刷新。
 * 顶栏按钮、输入框、浮层（`[data-overlay]` / `[data-slot^="sheet"]`）上的手势不拦，避免误触；
 * 列表行本身不排除（行根可能是 button，也可能只是普通容器），靠方向锁区分横滑与下拉。
 *
 * 带方向锁：手指移动 8px 后判定一次，只有「向下且纵向占优（|dy| > |dx| * 1.2）」
 * 才进入下拉；判定为横向后本次手势彻底忽略（不 setPull、不 preventDefault），
 * 与 `MobileSwipeEntryRow` 的横滑互不干扰。判定前不显示进度。
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
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const directionRef = useRef<PullDirection | null>(null);
  const pullRef = useRef(0);
  // 用 ref 稳定父级回调身份：onRefresh 变化不应重启监听、打断进行中的下拉。
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const reset = useCallback(() => {
    startXRef.current = null;
    startYRef.current = null;
    directionRef.current = null;
    pullRef.current = 0;
    setPull(0);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const onTouchStart = (event: TouchEvent) => {
      if (
        busy ||
        isRefreshing ||
        window.scrollY > 0 ||
        event.touches.length !== 1
      ) {
        reset();
        return;
      }
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(
          "button, a, input, textarea, select, [role='dialog'], [data-no-pull], [data-overlay], [data-slot='sheet'], [data-slot='sheet-overlay'], [data-slot='sheet-content']",
        )
      ) {
        reset();
        return;
      }
      startXRef.current = event.touches[0]?.clientX ?? null;
      startYRef.current = event.touches[0]?.clientY ?? null;
      directionRef.current = "undetermined";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (
        startXRef.current === null ||
        startYRef.current === null ||
        event.touches.length !== 1
      ) {
        return;
      }
      const dx = (event.touches[0]?.clientX ?? 0) - startXRef.current;
      const dy = (event.touches[0]?.clientY ?? 0) - startYRef.current;

      // 8px 内方向未定：不拉进度条、不阻断滚动，等下一次 move 再判。
      if (directionRef.current === "undetermined") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_LOCK_DISTANCE) {
          return;
        }
        if (
          window.scrollY > 0 ||
          dy <= 0 ||
          Math.abs(dy) <= Math.abs(dx) * DIRECTION_LOCK_RATIO
        ) {
          // 横向 / 向上 / 页面已滚动：本次手势彻底放弃，直到 touchend。
          directionRef.current = "ignored";
          return;
        }
        directionRef.current = "vertical";
      }

      // 已判定横向（或其它非下拉方向）：保持静默，交给条目横滑。
      if (directionRef.current !== "vertical") return;

      // 任何阶段识别为横滑都放弃本次手势：不 setPull、不 preventDefault，
      // 让横向原生滚动通过（即使此前已经拉过阈值）。
      if (Math.abs(dx) > Math.abs(dy) * DIRECTION_LOCK_RATIO) {
        directionRef.current = "ignored";
        reset();
        return;
      }

      if (dy <= 0 || window.scrollY > 0) {
        if (pullRef.current !== 0) reset();
        return;
      }
      // 阻尼：手指走 160px 时指示器大约走 80px，越拉越沉。
      const next = Math.min(MAX_PULL, Math.pow(dy, 0.86));
      pullRef.current = next;
      setPull(next);
      if (event.cancelable) event.preventDefault();
    };

    const onTouchEnd = () => {
      if (startYRef.current === null) return;
      const shouldRefresh =
        directionRef.current === "vertical" && pullRef.current >= PULL_THRESHOLD;
      startYRef.current = null;
      if (!shouldRefresh) {
        reset();
        return;
      }
      setBusy(true);
      setPull(PULL_THRESHOLD);
      void Promise.resolve(onRefreshRef.current()).finally(() => {
        setBusy(false);
        reset();
      });
    };

    // 系统取消手势只复位，不触发刷新。
    const onTouchCancel = () => {
      reset();
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [busy, enabled, isRefreshing, reset]);

  // 只在 enabled 变化（含卸载）时复位；父级重渲染不重置进行中的下拉。
  useEffect(() => {
    if (!enabled) return;
    return () => {
      reset();
    };
  }, [enabled, reset]);

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
