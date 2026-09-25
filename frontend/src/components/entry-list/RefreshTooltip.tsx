import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, ProgressBar } from "@heroui/react";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import type { RefreshFeedResult, RefreshStatus } from "@/api";
import {
  buildRefreshReport,
  useRefreshReportStore,
} from "@/stores/refresh-report-store";

/**
 * 刷新按钮的悬浮浮层（2.1：悬停看刷新内容，照 mrrss 的做法）。
 *
 * - 刷新中：首行「正在刷新 · 26 / 59」+ 触发方式（手动/定时）+ 已跑时长；
 *   一条 HeroUI ProgressBar；下面逐源结果（`源名` + `+3` / `无新条目` / `失败 · 原因`），
 *   最多 8 行、其余折叠成「还有 N 个源排队中」；底部「查看完整报告」→ 打开现有刷新结果弹框。
 * - 空闲：上次刷新摘要 +「查看完整报告」。
 * - 只读浮层、不挡点击：用受控 Popover（hover 开 / leave 关），不用需要点关闭的弹窗。
 *   不用 Tooltip：Tooltip 内容不可交互，放不下「查看完整报告」按钮。
 */
import type { TFunction } from "i18next";
type T = TFunction<"translation", undefined>;

const MAX_ROWS = 8;

function resultLabel(item: RefreshFeedResult, t: T): string {
  if (item.skipped) return t("refresh_tooltip.skipped");
  if (item.error) return t("refresh_tooltip.failed", { reason: item.error });
  const total = (item.new ?? 0) + (item.updated ?? 0);
  if (total <= 0) return t("refresh_tooltip.no_new");
  return `+${total}`;
}

function elapsedText(startedAt: string | undefined, t: T): string {
  if (!startedAt) return "";
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return t("refresh_tooltip.elapsed", { count: secs });
}

export function RefreshTooltip({
  status,
  children,
}: {
  status: RefreshStatus | undefined;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const openReport = useRefreshReportStore((state) => state.open);
  const [open, setOpen] = useState(false);

  const refreshing = Boolean(status?.isRefreshing);
  const total = status?.total ?? 0;
  const completed = status?.completed ?? 0;
  const results = status?.results ?? [];
  const shown = results.slice(0, MAX_ROWS);
  const pending = Math.max(0, total - completed);

  const newTotal = results.reduce((s, r) => s + (r.new ?? 0) + (r.updated ?? 0), 0);

  const openFullReport = () => {
    if (results.length === 0) return;
    setOpen(false);
    openReport(buildRefreshReport(results));
  };

  return (
    <Popover.Root isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </Popover.Trigger>
      <Popover.Content placement="bottom" className="w-80">
        <Popover.Dialog
          className="p-3"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {refreshing ? (
            <>
              <div className="flex items-baseline gap-2">
                <strong className="text-sm">
                  {t("refresh_tooltip.refreshing", { completed, total })}
                </strong>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {status?.trigger === "auto"
                    ? t("refresh_tooltip.trigger_auto")
                    : t("refresh_tooltip.trigger_manual")}
                  {status?.startedAt ? ` · ${elapsedText(status.startedAt, t)}` : ""}
                </span>
              </div>
              <ProgressBar
                aria-label={t("refresh_tooltip.refreshing", { completed, total })}
                className="my-2 w-full"
                size="sm"
                maxValue={Math.max(1, total)}
                value={completed}
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <div className="max-h-64 overflow-y-auto">
                {shown.map((item) => (
                  <div
                    key={item.feedId}
                    className="flex items-center gap-2 py-0.5 text-xs"
                    data-slot="refresh-tooltip-row"
                  >
                    <FeedAvatar
                      iconPath={item.iconPath}
                      alt={item.title}
                      size={16}
                      className="shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span
                      className={
                        item.error
                          ? "shrink-0 text-danger"
                          : "shrink-0 text-muted-foreground tabular-nums"
                      }
                    >
                      {resultLabel(item, t)}
                    </span>
                  </div>
                ))}
                {pending > 0 && (
                  <div className="py-0.5 text-xs text-muted-foreground">
                    {t("refresh_tooltip.pending", { count: pending })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              {status?.lastRefreshedAt
                ? t("refresh_tooltip.last_summary", {
                    at: new Date(status.lastRefreshedAt).toLocaleString(),
                    count: results.length,
                    added: newTotal,
                  })
                : t("refresh_tooltip.never")}
            </div>
          )}
          {results.length > 0 && (
            <button
              type="button"
              onClick={openFullReport}
              className="mt-2 w-full rounded-[var(--radius)] px-2 py-1 text-center text-xs text-accent transition-colors hover:bg-item-hover"
              data-slot="refresh-tooltip-report"
            >
              {t("refresh_tooltip.view_report")}
            </button>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover.Root>
  );
}
