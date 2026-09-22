import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useFeeds } from "@/hooks/useFeeds";
import { deleteFeeds, refreshAllFeeds, ApiError } from "@/api";
import { cn } from "@/lib/utils";
import {
  formatDate,
  formatDateTime,
  compareStrings,
  getSortIcon,
} from "@/lib/table-utils";
import { EditFeedDialog } from "./EditFeedDialog";
import type { Feed } from "@/types/api";

type SortField = "title" | "createdAt" | "updatedAt";
type SortDirection = "asc" | "desc";

export function FeedsSettings() {
  const { t } = useTranslation();
  const { data: feeds = [], isLoading, refetch } = useFeeds();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("title");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  /** 筛选：全部 / 只显示有自定义设置的 / 只显示没自定义设置的 */
  const [overrideFilter, setOverrideFilter] = useState<
    "all" | "custom" | "plain"
  >("all");
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);

  const sortedFeeds = useMemo(() => {
    return [...feeds].sort((a, b) => {
      let cmp = 0;
      if (sortField === "title") {
        cmp = compareStrings(a.title, b.title);
      } else if (sortField === "createdAt") {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (sortField === "updatedAt") {
        cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [feeds, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const renderSortIcon = (field: SortField) => {
    const icon = getSortIcon(sortField, field, sortDirection);
    const className =
      sortField === field ? "ml-1" : "ml-1 text-muted-foreground/50";
    return <span className={className}>{icon}</span>;
  };

  const handleSelectAll = () => {
    if (selectedIds.size === feeds.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(feeds.map((f) => f.id)));
    }
  };

  const handleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleRefreshAll = async () => {
    setError(null);
    setIsRefreshing(true);
    try {
      await refreshAllFeeds();
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t("feeds.refresh_in_progress"));
      } else {
        setError(t("feeds.refresh_failed"));
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    setError(null);
    setIsDeleting(true);
    try {
      await deleteFeeds(Array.from(selectedIds));
      setSelectedIds(new Set());
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    } catch {
      setError(t("feeds.delete_failed"));
    } finally {
      setIsDeleting(false);
    }
  };

  const isAllSelected = feeds.length > 0 && selectedIds.size === feeds.length;
  const isPartialSelected =
    selectedIds.size > 0 && selectedIds.size < feeds.length;

  // 只看「有/没有自定义设置」的订阅：自动翻译、自动摘要、摘要提示词任一被单独设过就算有
  const visibleFeeds = useMemo(() => {
    if (overrideFilter === "all") return sortedFeeds;
    return sortedFeeds.filter((feed) => {
      const custom =
        feed.autoTranslate != null ||
        feed.autoSummary != null ||
        feed.readerMode != null ||
        !!feed.summaryPromptReminder;
      return overrideFilter === "custom" ? custom : !custom;
    });
  }, [overrideFilter, sortedFeeds]);

  const customCount = useMemo(
    () =>
      feeds.filter(
        (feed) =>
          feed.autoTranslate != null ||
          feed.autoSummary != null ||
          feed.readerMode != null ||
          !!feed.summaryPromptReminder,
      ).length,
    [feeds],
  );

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">
            {t("feeds.subscribed_feeds", { count: feeds.length })}
          </h3>
          {/* 筛选：有没有自定义设置（自动翻译 / 自动摘要 / 摘要提示词） */}
          <div className="flex shrink-0 gap-1 rounded-full border border-border p-0.5">
            {(
              [
                { value: "all" as const, label: t("feeds.filter_all") },
                {
                  value: "custom" as const,
                  label: t("feeds.filter_custom", { count: customCount }),
                },
                {
                  value: "plain" as const,
                  label: t("feeds.filter_plain"),
                },
              ]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setOverrideFilter(option.value)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs transition-colors duration-200",
                  overrideFilter === option.value
                    ? "bg-item-active text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefreshAll}
            disabled={isRefreshing}
            className={cn(
              "flex items-center gap-1.5 rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium transition-colors",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <svg
              className={cn("size-4", isRefreshing && "animate-spin")}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>
              {isRefreshing ? t("feeds.refreshing") : t("feeds.refresh_all")}
            </span>
          </button>
          <button
            type="button"
            onClick={handleDeleteSelected}
            disabled={selectedIds.size === 0 || isDeleting}
            className={cn(
              "flex items-center gap-1.5 rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium transition-colors",
              "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            <span>
              {isDeleting
                ? t("feeds.deleting")
                : t("feeds.delete_count", { count: selectedIds.size })}
            </span>
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Table */}
      {feeds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-secondary/20 p-8 text-center">
          <p className="text-sm text-muted-foreground">{t("feeds.no_feeds")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-secondary/50">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className={cn(
                      "flex size-4 items-center justify-center rounded border transition-colors",
                      isAllSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : isPartialSelected
                          ? "border-primary bg-primary/50 text-primary-foreground"
                          : "border-border bg-background hover:border-primary/50",
                    )}
                  >
                    {(isAllSelected || isPartialSelected) && (
                      <svg
                        className="size-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d={isPartialSelected ? "M5 12h14" : "M5 13l4 4L19 7"}
                        />
                      </svg>
                    )}
                  </button>
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => handleSort("title")}
                    className="flex items-center hover:text-foreground transition-colors"
                  >
                    {t("feeds.name")}
                    {renderSortIcon("title")}
                  </button>
                </th>
                <th className="hidden sm:table-cell w-28 px-3 py-2 text-left font-medium text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => handleSort("createdAt")}
                    className="flex items-center hover:text-foreground transition-colors"
                  >
                    {t("feeds.subscribe_date")}
                    {renderSortIcon("createdAt")}
                  </button>
                </th>
                <th className="hidden sm:table-cell w-36 px-3 py-2 text-left font-medium text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => handleSort("updatedAt")}
                    className="flex items-center hover:text-foreground transition-colors"
                  >
                    {t("feeds.last_update")}
                    {renderSortIcon("updatedAt")}
                  </button>
                </th>
                <th className="w-16 px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("feeds.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleFeeds.map((feed: Feed) => {
                const isSelected = selectedIds.has(feed.id);
                return (
                  <tr
                    key={feed.id}
                    className={cn(
                      "transition-colors",
                      isSelected ? "bg-primary/5" : "hover:bg-secondary/30",
                    )}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => handleSelect(feed.id)}
                        className={cn(
                          "flex size-4 items-center justify-center rounded border transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background hover:border-primary/50",
                        )}
                      >
                        {isSelected && (
                          <svg
                            className="size-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={3}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </button>
                    </td>
                    <td className="max-w-[200px] px-3 py-2">
                      <div className="flex items-center gap-2">
                        {feed.iconPath ? (
                          <img
                            src={`/icons/${feed.iconPath}`}
                            alt=""
                            className="size-4 shrink-0 rounded-[var(--ui-icon-radius,4px)] object-contain"
                          />
                        ) : (
                          <div className="flex size-4 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
                            <svg
                              className="size-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M6 5c7.18 0 13 5.82 13 13M6 11a7 7 0 017 7m-6 0a1 1 0 11-2 0 1 1 0 012 0z"
                              />
                            </svg>
                          </div>
                        )}
                        <span
                          className="truncate font-medium"
                          title={feed.title}
                        >
                          {feed.title}
                        </span>
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-3 py-2 text-muted-foreground">
                      {formatDate(feed.createdAt)}
                    </td>
                    <td className="hidden sm:table-cell px-3 py-2 text-muted-foreground">
                      {formatDateTime(feed.updatedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setEditingFeed(feed)}
                        className={cn(
                          "flex size-7 items-center justify-center rounded transition-colors",
                          "text-muted-foreground hover:bg-secondary hover:text-foreground",
                        )}
                        title={t("feeds.edit")}
                      >
                        <svg
                          className="size-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EditFeedDialog
        feed={editingFeed}
        open={editingFeed !== null}
        onOpenChange={(open) => !open && setEditingFeed(null)}
      />
    </div>
  );
}
