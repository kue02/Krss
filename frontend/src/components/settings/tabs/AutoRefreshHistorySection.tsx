import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Chip,
  Disclosure,
  ScrollShadow,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { Copy, RefreshCw } from "lucide-react";
import { refreshFeeds, type RefreshFeedResult } from "@/api";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { MarqueeText } from "@/components/ui/marquee-text";
import { cn } from "@/lib/utils";
import { copyToClipboard, showToast } from "@/stores/toast-store";
import {
  clearAutoRefreshHistory,
  groupRefreshFailures,
  loadAutoRefreshHistory,
  sortRefreshSuccesses,
  subscribeAutoRefreshHistory,
  type AutoRefreshRecord,
} from "@/lib/auto-refresh-history";

/**
 * 设置 → 高级 · 自动刷新历史（第十九批重做，效果图
 * `mockups/auto-refresh-history.html`（本地草图，未入库））。
 *
 * 12-17 那版「能用但不好用」：20 条是一叠同款描边行，时间与三个数字挤在一句里、
 * 数字不对齐、失败只是个红字、展开后 77 行表格要把失败自己找出来。这版按效果图改四件事：
 *   ① 拆列（时间 / 三个等宽数字 / 状态 / 展开箭头各一列）
 *   ② 失败行加左红条 + 红数字；全成功那行给「全部成功」灰标作对照
 *   ③ 展开后失败置顶 + 按原因分组 + 可复制 + 可直接重试这 N 个源
 *   ④ 顶部「全部 / 只看失败」筛选
 * 另加：列表固定最大高度、内部滚动（否则 20 条一路向下会把「高级」里下面的设置项顶走）。
 *
 * 三条已拍板边界：保留固定最近 20 次（不做可配，见 `lib/auto-refresh-history.ts` 的
 * `AUTO_REFRESH_HISTORY_LIMIT`）· 清空走 HeroUI `AlertDialog` 二次确认 ·
 * **手动刷新不记进这份历史**（记的事在 `useRefreshReportWatcher` 里按 `trigger` 分流）。
 */

type HistoryFilter = "all" | "failed";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 时间拆成「日期 + 时刻」两段：今天只写时刻（配一个「今天」标签），
 * 别的日子补上日期 —— 20 条通常横跨几天，不写日期会分不清是哪天。
 */
function formatWhen(at: string): { today: boolean; day: string; time: string } {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { today: false, day: "", time: at };
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date();
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return {
    today,
    day: today ? "" : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    time,
  };
}

/** 相对时间（「8 分钟前」）。不到一分钟返回 null，由调用方显示「刚刚」 */
function formatAgo(at: string): { key: string; count: number } | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60)
    return { key: "settings.auto_refresh_history_minutes_ago", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return { key: "settings.auto_refresh_history_hours_ago", count: hours };
  return {
    key: "settings.auto_refresh_history_days_ago",
    count: Math.floor(hours / 24),
  };
}

/** 一轮刷新的三个数字（等宽、等宽列宽，跨行对齐） */
function StatChip({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <Chip
      size="sm"
      variant="tertiary"
      className={cn(
        "w-full justify-between border",
        danger ? "border-destructive/45" : "border-border",
      )}
    >
      <Chip.Label
        className={cn(
          "ps-0",
          danger ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </Chip.Label>
      <b
        className={cn(
          "pe-0.5 font-semibold tabular-nums",
          danger ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </b>
    </Chip>
  );
}

/** 展开后的一条订阅（失败项在分组里、成功项在下面的列表里，用的是同一块） */
function FeedLine({
  feed,
  trailing,
}: {
  feed: RefreshFeedResult;
  trailing: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-secondary/40">
      <FeedAvatar iconPath={feed.iconPath} size={16} rounded="circle" />
      <MarqueeText text={feed.title} className="min-w-0 flex-1 text-xs" />
      {trailing}
    </div>
  );
}

export function AutoRefreshHistorySection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [records, setRecords] = useState<AutoRefreshRecord[]>(() =>
    loadAutoRefreshHistory(),
  );
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [clearOpen, setClearOpen] = useState(false);
  /** 正在重试哪一条（按 `at` 定位）—— 重试期间按钮禁用，避免连点 */
  const [retryingAt, setRetryingAt] = useState<string | null>(null);

  useEffect(
    () => subscribeAutoRefreshHistory(() => setRecords(loadAutoRefreshHistory())),
    [],
  );

  const visible = useMemo(
    () =>
      filter === "failed"
        ? records.filter(
            (record) =>
              record.failedCount > 0 ||
              record.results.some((result) => result.error),
          )
        : records,
    [records, filter],
  );

  /** 最新的那次（`records` 是「新的在前」，后端每轮结束 append 到头部） */
  const latestAt = records[0]?.at;

  /**
   * 直接重试这 N 个源。
   *
   * 走既有的 `POST /api/feeds/refresh {feedIds}`（后端把 `lastTrigger` 置成 `manual`）
   * ⇒ 结果是**弹框**、**不写回这份历史** —— 与 19-6「手动刷新不记」是同一条口径，
   * 所以这里不需要（也不该）自己往历史里补一条。
   */
  const retryFeeds = async (at: string, feeds: RefreshFeedResult[]) => {
    if (feeds.length === 0) return;
    setRetryingAt(at);
    try {
      await refreshFeeds(feeds.map((feed) => feed.feedId));
      // 发完立刻刷一次全局刷新状态：否则中栏进度条与「刷新完成」弹框要等下一次
      // 15s 轮询才出现，用户看到的就是「点了没反应」（12-10 踩过同一个坑 ——
      // 后台任务的进度 UI 必须读全局状态，各入口触发后都要立刻 invalidate）。
      void queryClient.invalidateQueries({ queryKey: ["refreshStatus"] });
      showToast(t("entry.refreshing_n_feeds", { count: feeds.length }));
    } catch {
      showToast(t("entry.refresh_failed"));
    } finally {
      setRetryingAt(null);
    }
  };

  const confirmClear = () => {
    clearAutoRefreshHistory();
    setRecords([]);
    setClearOpen(false);
  };

  return (
    <section>
      {/* 顶栏：标题 + 「全部 / 只看失败」筛选 + 清空 */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">
            {t("settings.auto_refresh_history")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.auto_refresh_history_hint")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {records.length > 0 && (
            <ToggleButtonGroup
              selectionMode="single"
              disallowEmptySelection
              size="sm"
              selectedKeys={[filter]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                setFilter(next === "failed" ? "failed" : "all");
              }}
            >
              <ToggleButton id="all">
                {t("settings.auto_refresh_history_filter_all")}
              </ToggleButton>
              <ToggleButton id="failed">
                {t("settings.auto_refresh_history_filter_failed")}
              </ToggleButton>
            </ToggleButtonGroup>
          )}
          {records.length > 0 && (
            <Button size="sm" variant="ghost" onPress={() => setClearOpen(true)}>
              {t("settings.auto_refresh_history_clear")}
            </Button>
          )}
        </div>
      </div>

      {records.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {t("settings.auto_refresh_history_empty")}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {t("settings.auto_refresh_history_filter_empty")}
        </div>
      ) : (
        /**
         * 固定最大高度 + 内部滚动（19-5）：20 条一路向下会把「高级」里它下面的
         * 设置项（拉取 / 域名限速）顶出屏幕。展开的明细也留在同一个滚动区里。
         * 用 HeroUI `ScrollShadow`（它自己带 `overflow-y-auto` 与滚动渐隐），只补 max-height。
         */
        <ScrollShadow className="max-h-[232px]">
          <div className="space-y-1.5 pe-1">
            {visible.map((record, index) => {
              const when = formatWhen(record.at);
              const ago = formatAgo(record.at);
              const failures = groupRefreshFailures(record.results);
              const successes = sortRefreshSuccesses(record.results);
              /**
               * 以「明细里的失败项」为准（同一个数写库时就是这个口径）；
               * 老记录万一只存了计数、没存明细，退回 `failedCount`，至少数字不会凭空消失。
               */
              const failedFeeds = record.results.filter(
                (result) => result.error,
              );
              const failedCount = failedFeeds.length || record.failedCount;
              const isFailed = failedCount > 0;
              const isLatest = record.at === latestAt;

              return (
                // at 是秒级时间戳：两轮同秒结束就会撞 key（线上实锤 console.error），
                // record 又没有唯一 id，只能缀 index（列表只增不改，就近展开态不受影响）
                <Disclosure key={`${record.at}#${index}`}>
                  <Disclosure.Heading>
                    {/*
                      四列：时间 / 三个数字 / 状态 / 展开箭头（19-1）。
                      用「固定宽 + 弹性中列」而不是等宽网格：状态列若跟着内容走，
                      有状态标的那行与没状态标的行中列宽度不同 → 三个数字会左右跳
                      （真机实测：同一份数据里中列 456px 与 518px 两种值，正是用户说的「数字不对齐」）。
                      窄屏（手机设置页）让弹性中列整块换行，不挤成一团。
                    */}
                    <Disclosure.Trigger
                      className={cn(
                        "relative flex w-full flex-wrap items-center gap-x-3 gap-y-1.5",
                        "rounded-lg border px-3 py-2 text-left transition-colors hover:bg-secondary/40",
                        isFailed ? "border-destructive/40" : "border-border",
                        isLatest && !isFailed && "bg-primary/5",
                      )}
                    >
                      {/* 失败行左红条（19-2）—— 与草图的 inset 红条同形 */}
                      {isFailed && (
                        <span
                          aria-hidden
                          className="absolute inset-y-2 start-0 w-[3px] rounded-e-[3px] bg-destructive"
                        />
                      )}

                      <span className="w-[7.5rem] shrink-0">
                        <span className="block truncate text-xs font-medium tabular-nums">
                          {when.today
                            ? `${t("settings.auto_refresh_history_today")} ${when.time}`
                            : when.time}
                        </span>
                        <span className="block truncate text-[10.5px] text-muted-foreground">
                          {when.today
                            ? ago
                              ? t(ago.key, { count: ago.count })
                              : t("settings.auto_refresh_history_just_now")
                            : when.day}
                        </span>
                      </span>

                      <span className="grid min-w-[13rem] flex-1 grid-cols-3 gap-1.5">
                        <StatChip
                          label={t("settings.auto_refresh_history_stat_new")}
                          value={record.newCount}
                        />
                        <StatChip
                          label={t("settings.auto_refresh_history_stat_updated")}
                          value={record.updatedCount}
                        />
                        <StatChip
                          label={t("settings.auto_refresh_history_stat_failed")}
                          value={failedCount}
                          danger={isFailed}
                        />
                      </span>

                      <span className="w-[4.5rem] shrink-0 text-end">
                        {isLatest ? (
                          <Chip
                            size="sm"
                            variant="tertiary"
                            className="border border-primary/40 text-primary"
                          >
                            {t("settings.auto_refresh_history_latest")}
                          </Chip>
                        ) : !isFailed ? (
                          <Chip
                            size="sm"
                            variant="tertiary"
                            className="border border-border text-muted-foreground"
                          >
                            {t("settings.auto_refresh_history_all_ok")}
                          </Chip>
                        ) : null}
                      </span>

                      <Disclosure.Indicator className="size-4 shrink-0 text-muted-foreground" />
                    </Disclosure.Trigger>
                  </Disclosure.Heading>

                  <Disclosure.Content>
                    <Disclosure.Body className="rounded-lg border border-border px-3 py-2.5">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {isFailed ? (
                            <>
                              <b className="font-medium text-foreground">
                                {t(
                                  "settings.auto_refresh_history_failed_sources",
                                  { count: failedCount },
                                )}
                              </b>
                              {" · "}
                              {t("settings.auto_refresh_history_grouped_by_reason")}
                            </>
                          ) : (
                            t("settings.auto_refresh_history_all_ok_hint")
                          )}
                        </span>
                        {isFailed && (
                          <span className="flex shrink-0 items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() =>
                                void copyToClipboard(
                                  failedFeeds
                                    .map(
                                      (feed) => `${feed.title}: ${feed.error ?? ""}`,
                                    )
                                    .join("\n"),
                                  t("settings.auto_refresh_history_copied"),
                                  t("actions.copy_failed"),
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                              {t(
                                "settings.auto_refresh_history_copy_all_reasons",
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="tertiary"
                              isDisabled={retryingAt === record.at}
                              onPress={() => void retryFeeds(record.at, failedFeeds)}
                            >
                              <RefreshCw className="size-3.5" />
                              {t("settings.auto_refresh_history_retry", {
                                count: failedCount,
                              })}
                            </Button>
                          </span>
                        )}
                      </div>

                      {/* 失败置顶（19-3）：一条原因一组，组内是受影响的源 */}
                      {failures.map((group) => (
                        <div key={group.reason} className="mb-1.5">
                          <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-secondary/40">
                            <MarqueeText
                              text={group.reason}
                              className="min-w-0 flex-1 text-xs text-destructive"
                            />
                            <Chip
                              size="sm"
                              variant="tertiary"
                              className="border border-destructive/40 tabular-nums text-destructive"
                            >
                              {group.feeds.length}
                            </Chip>
                            <Button
                              size="sm"
                              variant="ghost"
                              isIconOnly
                              aria-label={t(
                                "settings.auto_refresh_history_copy_reason",
                              )}
                              onPress={() =>
                                void copyToClipboard(
                                  group.reason,
                                  t("settings.auto_refresh_history_copied"),
                                  t("actions.copy_failed"),
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </div>
                          <div className="ps-3">
                            {group.feeds.map((feed) => (
                              <div
                                key={feed.feedId}
                                className="truncate px-1.5 text-xs text-muted-foreground"
                                title={feed.title}
                              >
                                {feed.title}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {successes.length > 0 && (
                        <>
                          <div className="mb-1 mt-2 text-[11px] text-muted-foreground">
                            {t("settings.auto_refresh_history_ok_sources", {
                              count: successes.length,
                            })}
                          </div>
                          {successes.map((feed) => (
                            <FeedLine
                              key={feed.feedId}
                              feed={feed}
                              trailing={
                                <>
                                  <Chip
                                    size="sm"
                                    variant="tertiary"
                                    className="border border-border text-muted-foreground"
                                  >
                                    {t(
                                      "settings.auto_refresh_history_stat_updated",
                                    )}{" "}
                                    <b className="tabular-nums text-foreground">
                                      {feed.updated}
                                    </b>
                                  </Chip>
                                  <Chip
                                    size="sm"
                                    variant="tertiary"
                                    className="border border-border text-muted-foreground"
                                  >
                                    {t("settings.auto_refresh_history_stat_new")}{" "}
                                    <b className="tabular-nums text-foreground">
                                      {feed.new}
                                    </b>
                                  </Chip>
                                </>
                              }
                            />
                          ))}
                        </>
                      )}
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              );
            })}
          </div>
        </ScrollShadow>
      )}

      {/* 清空确认（19-6）：历史删了找不回来，走 HeroUI AlertDialog 二次确认 */}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={clearOpen}
          onOpenChange={(open) => !open && setClearOpen(false)}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-md">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {t("settings.auto_refresh_history_clear_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {t("settings.auto_refresh_history_clear_description", {
                    count: records.length,
                  })}
                </div>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setClearOpen(false)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button size="sm" variant="danger" onPress={confirmClear}>
                  {t("settings.auto_refresh_history_clear")}
                </Button>
              </AlertDialog.Footer>
              <AlertDialog.CloseTrigger />
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </section>
  );
}
