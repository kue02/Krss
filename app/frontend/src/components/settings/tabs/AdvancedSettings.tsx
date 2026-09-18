import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Edit2, Check, X, Copy } from "lucide-react";
import { Button, Disclosure, Label, NumberField, Table } from "@heroui/react";
import {
  getDomainRateLimits,
  createDomainRateLimit,
  updateDomainRateLimit,
  deleteDomainRateLimit,
  getFetchSettings,
  updateFetchSettings,
  ApiError,
} from "@/api";
import type { FetchSettings } from "@/types/settings";
import { MarqueeText } from "@/components/ui/marquee-text";
import { showToast } from "@/stores/toast-store";
import {
  clearAutoRefreshHistory,
  loadAutoRefreshHistory,
  subscribeAutoRefreshHistory,
  type AutoRefreshRecord,
} from "@/lib/auto-refresh-history";
import type { DomainRateLimit } from "@/types/settings";
import { cn } from "@/lib/utils";

export function AdvancedSettings() {
  /** 12-19：表头点击排序（HeroUI Button 自己管状态，见 SortHeader） */
  const [sortDescriptor, setSortDescriptor] = useState<{
    column: string;
    direction: "ascending" | "descending";
  }>({ column: "updated", direction: "descending" });
  const toggleSort = (column: string) =>
    setSortDescriptor((prev) =>
      prev.column === column
        ? {
            column,
            direction:
              prev.direction === "ascending" ? "descending" : "ascending",
          }
        : { column, direction: "descending" },
    );

  const { t } = useTranslation();
  const [items, setItems] = useState<DomainRateLimit[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // 自动刷新历史（用户 12-17）：定时刷新不再弹框，改成这里一份可下拉的历史
  const [autoHistory, setAutoHistory] = useState<AutoRefreshRecord[]>(() =>
    loadAutoRefreshHistory(),
  );
  useEffect(() => subscribeAutoRefreshHistory(() => setAutoHistory(loadAutoRefreshHistory())), []);

  // 拉取设置（用户 11-20）：定时频率 / 全局并发 / 同主机并发 / 单源超时。
  // 都是「下一轮生效」：后端每轮刷新开始时读一次，改完不用重启。
  const [fetchDraft, setFetchDraft] = useState<FetchSettings | null>(null);
  const [fetchSaving, setFetchSaving] = useState(false);
  /**
   * 最新草稿的 ref。
   *
   * HeroUI 的 NumberField（底层 react-aria）**只在失焦/回车时才提交值** ——
   * 于是「改完直接点保存」时 state 还是旧值（按钮还是禁用态，点了没反应，最难查的那种失败）。
   * 点保存本身会让输入框失焦、onChange 立刻触发，只是那次 setState 赶不上这次点击的闭包；
   * 所以这里同时写一份 ref，保存时以 ref 为准。
   */
  const draftRef = useRef<FetchSettings | null>(null);
  const [fetchStatus, setFetchStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const loadFetchSettings = useCallback(async () => {
    try {
      const data = await getFetchSettings();
      setFetchDraft(data);
      draftRef.current = data;
    } catch {
      // 读不到就整块不显示，不要摆一堆 0 让人以为设置坏了
    }
  }, []);

  useEffect(() => {
    void loadFetchSettings();
  }, [loadFetchSettings]);

  const handleSaveFetch = useCallback(async () => {
    // 以 ref 为准：失焦提交的值可能还没进 state（见 draftRef 注释）
    const draft = draftRef.current ?? fetchDraft;
    if (!draft) return;
    setFetchSaving(true);
    setFetchStatus(null);
    try {
      const saved = await updateFetchSettings(draft);
      setFetchDraft(saved);
      draftRef.current = saved;
      setFetchStatus({ kind: "ok", text: t("settings.fetch_saved") });
    } catch (error) {
      setFetchStatus({
        kind: "error",
        text:
          error instanceof ApiError
            ? error.message
            : t("settings.fetch_save_failed"),
      });
    } finally {
      setFetchSaving(false);
    }
  }, [fetchDraft, t]);

  // Add state
  const [newHost, setNewHost] = useState("");
  const [newInterval, setNewInterval] = useState("");

  // Edit state
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editInterval, setEditInterval] = useState<number>(0);

  const loadData = useCallback(async () => {
    try {
      const data = await getDomainRateLimits();
      setItems(data.items);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const isValidHostFormat = (h: string) => {
    const trimmed = h.trim();
    if (!trimmed) return false;
    if (trimmed === "localhost") return true;

    // IPv4 check
    const ipv4Regex =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (ipv4Regex.test(trimmed)) return true;

    // IPv6 check (simplified but robust enough for frontend)
    if (trimmed.includes(":")) {
      const ipv6Regex =
        /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4})?::(([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4})?$/;
      return ipv6Regex.test(trimmed);
    }

    // Domain check (RFC 1123, requires at least one dot)
    const domainRegex =
      /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return domainRegex.test(trimmed);
  };

  const handleCreate = async () => {
    if (!newHost.trim() || !isValidHostFormat(newHost)) return;

    const interval = Math.max(0, parseInt(newInterval) || 0);
    try {
      await createDomainRateLimit(newHost.trim(), interval);
      setNewHost("");
      setNewInterval("");
      await loadData();
    } catch {
      // ignore
    }
  };

  const startEdit = (item: DomainRateLimit) => {
    setEditingHost(item.host);
    setEditInterval(item.intervalSeconds);
  };

  const cancelEdit = () => {
    setEditingHost(null);
    setEditInterval(0);
  };

  const handleUpdate = async () => {
    if (!editingHost) return;
    try {
      await updateDomainRateLimit(editingHost, editInterval);
      setEditingHost(null);
      await loadData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (host: string) => {
    if (!confirm(t("settings.confirm_delete") || "Are you sure?")) return;
    try {
      await deleteDomainRateLimit(host);
      await loadData();
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const fetchRows: Array<{
    key: keyof FetchSettings;
    label: string;
    hint: string;
    min: number;
    max: number;
  }> = [
    {
      key: "intervalMinutes",
      label: t("settings.fetch_interval"),
      hint: t("settings.fetch_interval_hint"),
      min: 1,
      max: 1440,
    },
    {
      key: "concurrency",
      label: t("settings.fetch_concurrency"),
      hint: t("settings.fetch_concurrency_hint"),
      min: 1,
      max: 64,
    },
    {
      key: "perHostConcurrency",
      label: t("settings.fetch_per_host"),
      hint: t("settings.fetch_per_host_hint"),
      min: 1,
      max: 64,
    },
    {
      key: "timeoutSeconds",
      label: t("settings.fetch_timeout"),
      hint: t("settings.fetch_timeout_hint"),
      min: 1,
      max: 300,
    },
  ];

  return (
    <div className="space-y-6">
      {/* 自动刷新历史（用户 12-17）：定时刷新的结果不再弹框，来这里看 */}
      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">
              {t("settings.auto_refresh_history")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.auto_refresh_history_hint")}
            </div>
          </div>
          {autoHistory.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                clearAutoRefreshHistory();
                setAutoHistory([]);
              }}
            >
              {t("settings.auto_refresh_history_clear")}
            </Button>
          )}
        </div>

        {autoHistory.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            {t("settings.auto_refresh_history_empty")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {autoHistory.map((record) => (
              <Disclosure key={record.at}>
                <Disclosure.Heading>
                  <Disclosure.Trigger className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-xs">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                      <span className="font-medium">
                        {new Date(record.at).toLocaleString()}
                      </span>
                      <span className="text-muted-foreground">
                        {t("settings.auto_refresh_history_summary", {
                          count: record.newCount + record.updatedCount,
                          created: record.newCount,
                          updated: record.updatedCount,
                        })}
                      </span>
                      {record.failedCount > 0 && (
                        <span className="text-destructive">
                          {t("settings.auto_refresh_history_failed", {
                            count: record.failedCount,
                          })}
                        </span>
                      )}
                    </span>
                    <Disclosure.Indicator className="size-4 shrink-0 text-muted-foreground" />
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="border border-t-0 border-border px-3 py-2">
                    {/* 12-19：用 HeroUI `Table`（可点表头排序）+ 跑马灯 + 复制按钮 */}
                    {/* 排序不用 RAC 的 `sortDescriptor`（HeroUI 的 Table 没声明这个 prop，
                        运行期也不保证透传）—— 表头里放 HeroUI `Button`，自己管排序状态 */}
                    <Table aria-label={t("settings.auto_refresh_history_table")}>
                      {/* HeroUI 的 `Table` 根只是个 div 包装，真正的 RAC 表格是 `Table.Content`；
                          少了这一层，Header/Body 会落在 RAC 表格上下文之外 → 运行期抛
                          「cannot be rendered outside a collection」（白屏）。 */}
                      <Table.Content>
                      <Table.Header>
                        <Table.Column id="title" isRowHeader>
                          <Table.SortableColumnHeader
                            sortDirection={
                              sortDescriptor.column === "title"
                                ? sortDescriptor.direction
                                : undefined
                            }
                            showIndicator={sortDescriptor.column === "title"}
                            onClick={() => toggleSort("title")}
                            className="cursor-pointer select-none"
                          >
                            {t("settings.auto_refresh_history_col_feed")}
                          </Table.SortableColumnHeader>
                        </Table.Column>
                        <Table.Column id="new">
                          <Table.SortableColumnHeader
                            sortDirection={
                              sortDescriptor.column === "new"
                                ? sortDescriptor.direction
                                : undefined
                            }
                            showIndicator={sortDescriptor.column === "new"}
                            onClick={() => toggleSort("new")}
                            className="cursor-pointer select-none"
                          >
                            {t("settings.auto_refresh_history_col_new")}
                          </Table.SortableColumnHeader>
                        </Table.Column>
                        <Table.Column id="updated">
                          <Table.SortableColumnHeader
                            sortDirection={
                              sortDescriptor.column === "updated"
                                ? sortDescriptor.direction
                                : undefined
                            }
                            showIndicator={sortDescriptor.column === "updated"}
                            onClick={() => toggleSort("updated")}
                            className="cursor-pointer select-none"
                          >
                            {t("settings.auto_refresh_history_col_updated")}
                          </Table.SortableColumnHeader>
                        </Table.Column>
                        <Table.Column id="error">
                          {t("settings.auto_refresh_history_col_error")}
                        </Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {[...record.results]
                          .sort((a, b) => {
                            const dir =
                              sortDescriptor.direction === "ascending" ? 1 : -1;
                            if (sortDescriptor.column === "new")
                              return (a.new - b.new) * dir;
                            if (sortDescriptor.column === "updated")
                              return (a.updated - b.updated) * dir;
                            if (sortDescriptor.column === "title")
                              return a.title.localeCompare(b.title) * dir;
                            return 0;
                          })
                          .map((result) => (
                            <Table.Row key={result.feedId} id={String(result.feedId)}>
                              <Table.Cell className="max-w-[16rem]">
                                <MarqueeText text={result.title} />
                              </Table.Cell>
                              <Table.Cell className="tabular-nums">
                                {result.new}
                              </Table.Cell>
                              <Table.Cell className="tabular-nums">
                                {result.updated}
                              </Table.Cell>
                              <Table.Cell className="max-w-[18rem]">
                                {result.error ? (
                                  <span className="flex min-w-0 items-center gap-1">
                                    <MarqueeText
                                      className="min-w-0 flex-1 text-destructive"
                                      text={result.error}
                                    />
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      isIconOnly
                                      aria-label={t("settings.auto_refresh_history_copy_error")}
                                      onPress={async () => {
                                        try {
                                          await navigator.clipboard.writeText(
                                            result.error ?? "",
                                          );
                                          showToast(
                                            t("settings.auto_refresh_history_copied"),
                                          );
                                        } catch {
                                          showToast(
                                            t("settings.auto_refresh_history_copy_failed"),
                                          );
                                        }
                                      }}
                                    >
                                      <Copy className="size-3.5" />
                                    </Button>
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                      </Table.Body>
                      </Table.Content>
                    </Table>
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            ))}
          </div>
        )}
      </section>

      {/* 拉取：频率与并发（用户 11-20） */}
      {fetchDraft && (
        <section>
          <div className="mb-4">
            <div className="text-sm font-medium">
              {t("settings.fetch_title")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.fetch_description")}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {fetchRows.map((row) => (
              <NumberField
                key={row.key}
                value={fetchDraft[row.key]}
                minValue={row.min}
                maxValue={row.max}
                onChange={(value) =>
                  setFetchDraft((prev) => {
                    if (!prev) return prev;
                    const next = { ...prev, [row.key]: Number(value) || 0 };
                    draftRef.current = next;
                    return next;
                  })
                }
                className="w-full"
              >
                <Label className="text-xs text-muted-foreground">
                  {row.label}
                </Label>
                <NumberField.Group className="mt-1">
                  <NumberField.DecrementButton>-</NumberField.DecrementButton>
                  <NumberField.Input />
                  <NumberField.IncrementButton>+</NumberField.IncrementButton>
                </NumberField.Group>
              </NumberField>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              onPress={handleSaveFetch}
              isDisabled={fetchSaving}
            >
              {t("actions.save")}
            </Button>
            <div className="text-xs text-muted-foreground">
              {t("settings.fetch_scope_hint")}
            </div>
            {fetchStatus && (
              <span
                className={cn(
                  "text-xs",
                  fetchStatus.kind === "ok"
                    ? "text-muted-foreground"
                    : "text-destructive",
                )}
              >
                {fetchStatus.text}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Domain Rate Limits Section */}
      <section>
        <div className="mb-4">
          <div className="text-sm font-medium">
            {t("settings.advanced_domain_limits")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.advanced_domain_limits_description")}
          </div>
        </div>

        <div className="space-y-2">
          {/* Add Row */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="example.com"
              className={cn(
                "h-9 min-w-[120px] flex-1 rounded-field border border-border bg-background px-3 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
            />
            <div className="flex shrink-0 items-center gap-2">
              <input
                type="number"
                min="0"
                value={newInterval}
                onChange={(e) => setNewInterval(e.target.value)}
                placeholder={t("settings.advanced_seconds")}
                className={cn(
                  "h-9 w-20 rounded-field border border-border bg-background px-3 text-sm",
                  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                )}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newHost.trim() || !isValidHostFormat(newHost)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-[var(--radius)] border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                <Plus className="size-4" />
              </button>
            </div>
          </div>

          {/* List */}
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t("settings.advanced_no_domains")}
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => {
                const isEditing = editingHost === item.host;
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
                  >
                    <div
                      className="min-w-[120px] flex-1 px-2 text-sm font-mono truncate"
                      title={item.host}
                    >
                      {item.host}
                    </div>

                    {isEditing ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          value={editInterval}
                          autoFocus
                          onChange={(e) =>
                            setEditInterval(
                              Math.max(0, parseInt(e.target.value) || 0),
                            )
                          }
                          className={cn(
                            "h-9 w-20 rounded-field border border-border bg-background px-3 text-sm",
                            "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                          )}
                        />
                        <button
                          type="button"
                          onClick={handleUpdate}
                          className="flex size-9 items-center justify-center rounded-[var(--radius)] text-primary hover:bg-primary/10"
                        >
                          <Check className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="flex size-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-secondary"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <div className="w-20 text-center text-xs text-muted-foreground">
                          {item.intervalSeconds}s
                        </div>
                        <button
                          type="button"
                          onClick={() => startEdit(item)}
                          className="flex size-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <Edit2 className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item.host)}
                          className="flex size-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
