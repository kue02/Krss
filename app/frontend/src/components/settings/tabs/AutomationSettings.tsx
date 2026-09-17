import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useFilterViewStore } from "@/stores/filter-view-store";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/api";
import { useFeeds } from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import {
  useApplyFilterHistory,
  useFilterDraft,
  useFilterMutations,
  useFilters,
} from "@/hooks/useFilters";
import { FilterMatchesDialog } from "@/components/automation/FilterMatchesDialog";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import { showToast } from "@/stores/toast-store";
import {
  describeActions,
  describeConditions,
  type FilterRule,
  type FilterWritePayload,
} from "@/types/filters";

function toWritePayload(rule: FilterRule, position: number): FilterWritePayload {
  return {
    name: rule.name,
    enabled: rule.enabled,
    position,
    kind: rule.kind === "view" ? "view" : "rule",
    scopeType: rule.scopeType,
    scopeId: rule.scopeId,
    conditions: rule.conditions ?? [],
    actions: rule.actions ?? {},
  };
}

function formatTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

/**
 * 设置 → 自动化：规则表格 + 筛选视图 + 编辑器抽屉入口。
 *
 * 全宽高密度表格（顶栏工具条 + 一行一条规则），次要操作（撤销、删除）压在行尾。
 * 顺序即优先级：命中即停，所以顺序做成显式上下移动，而不是藏一个优先级数字。
 *
 * 「自然语言建规则」只负责把模型给的草稿填进同一个编辑器 —— 生成的东西必须先被人看见，
 * 才可能被保存（模型说了不算，见后端 /api/filters/parse）。
 */
export function AutomationSettings() {
  // 「已静音条目」回看入口用（2026-09-17 从中栏胶囊搬来）
  const clearView = useFilterViewStore((state) => state.clearView);
  const setMutedOnly = useFilterViewStore((state) => state.setMutedOnly);
  const closeSettings = useSettingsModalStore((state) => state.close);
  const { t } = useTranslation();
  const { data: filters, isLoading, isError } = useFilters();
  const { data: feeds } = useFeeds();
  const { data: folders } = useFolders();
  const { update, remove, revert } = useFilterMutations();
  const applyHistory = useApplyFilterHistory();
  const nlDraft = useFilterDraft();
  const openNew = useFilterEditorStore((state) => state.openNew);
  const openNewView = useFilterEditorStore((state) => state.openNewView);
  const openEdit = useFilterEditorStore((state) => state.openEdit);
  const openWithDraft = useFilterEditorStore((state) => state.openWithDraft);

  const [pendingDelete, setPendingDelete] = useState<FilterRule | null>(null);
  const [deleteWithRevert, setDeleteWithRevert] = useState(true);
  const [matchesRule, setMatchesRule] = useState<FilterRule | null>(null);
  const [applyRule, setApplyRule] = useState<FilterRule | null>(null);
  const [nlOpen, setNlOpen] = useState(false);
  const [nlText, setNlText] = useState("");
  const [nlError, setNlError] = useState<string | null>(null);
  /** 回溯的扫描上限：一次别拖垮实例（后端上限 2000） */
  const applyHistoryLimit = 500;

  const sorted = useMemo(
    () =>
      [...(filters ?? [])]
        .filter((item) => item.kind !== "view")
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    [filters],
  );

  const views = useMemo(
    () =>
      [...(filters ?? [])]
        .filter((item) => item.kind === "view")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [filters],
  );

  const feedTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const feed of feeds ?? []) map.set(feed.id, feed.title);
    return map;
  }, [feeds]);

  const folderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders ?? []) map.set(folder.id, folder.name);
    return map;
  }, [folders]);

  const scopeLabel = (rule: FilterRule): string => {
    if (rule.scopeType === "feed") {
      return rule.scopeId
        ? (feedTitles.get(rule.scopeId) ?? t("automation.scope_feed"))
        : t("automation.scope_feed");
    }
    if (rule.scopeType === "folder") {
      return rule.scopeId
        ? (folderNames.get(rule.scopeId) ?? t("automation.scope_folder"))
        : t("automation.scope_folder");
    }
    return t("automation.scope_all");
  };

  const move = (rule: FilterRule, offset: number) => {
    const index = sorted.findIndex((item) => item.id === rule.id);
    const target = sorted[index + offset];
    if (!target) return;
    // 两条规则交换顺序位：位置是唯一的排序依据，交换后按新位置重排
    update.mutate({
      id: rule.id,
      payload: toWritePayload(rule, target.position),
    });
    update.mutate({
      id: target.id,
      payload: toWritePayload(target, rule.position),
    });
  };

  const handleRevert = (rule: FilterRule) => {
    revert.mutate(rule.id, {
      onSuccess: (result) => {
        showToast(
          result.reverted > 0
            ? t("automation.revert_done", { count: result.reverted })
            : t("automation.revert_none"),
        );
      },
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    remove.mutate(
      { id: pendingDelete.id, revert: deleteWithRevert },
      {
        onSuccess: (result) => {
          setPendingDelete(null);
          showToast(
            result.reverted > 0
              ? t("automation.revert_done", { count: result.reverted })
              : t("automation.deleted"),
          );
        },
      },
    );
  };

  /** 自然语言建规则：错误要能被看懂（AI 没配好 / 模型输出没法用 / 别的） */
  const handleGenerate = () => {
    const text = nlText.trim();
    if (!text) return;
    setNlError(null);
    nlDraft.mutate(text, {
      onSuccess: (draft) => {
        setNlOpen(false);
        setNlText("");
        openWithDraft(draft);
      },
      onError: (error) => {
        const message = error instanceof ApiError ? error.message : "";
        if (message === "ai_not_configured") {
          setNlError(t("automation.nl_ai_not_configured"));
          return;
        }
        if (message === "ai_draft_invalid") {
          setNlError(t("automation.nl_draft_invalid"));
          return;
        }
        setNlError(t("automation.nl_failed"));
      },
    });
  };

  const actionButton = cn(
    "rounded px-1.5 py-0.5 text-xs transition-colors",
    "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

  return (
    <div className="space-y-3">
      {/* 工具条 */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            {t("automation.subtitle")}
          </div>
          {sorted.length > 1 && (
            <div className="mt-0.5 text-xs text-muted-foreground/70">
              {t("automation.order_hint")}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setNlError(null);
              setNlOpen(true);
            }}
            className={cn(
              "h-8 rounded-md border border-border px-3 text-sm font-medium",
              "transition-colors hover:bg-accent",
            )}
          >
            {t("automation.nl_open")}
          </button>
          <button
            type="button"
            onClick={openNew}
            className={cn(
              "h-8 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90",
            )}
          >
            + {t("automation.new_rule")}
          </button>
        </div>
      </div>

      {/* 「已静音」回看入口 —— 2026-09-17 从「中栏筛选胶囊」搬到这里：
          被规则静音的东西是个回看角落，不该占中栏的高位入口；
          放在自动化页也顺手回答了「它为什么被静音」（规则都在这一页） */}
      <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("automation.muted_entries")}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("automation.muted_entries_hint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            clearView();
            setMutedOnly(true);
            closeSettings();
          }}
          className={cn(
            "h-8 shrink-0 rounded-md border border-border px-3 text-sm font-medium",
            "transition-colors hover:bg-accent",
          )}
        >
          {t("automation.muted_entries_open")}
        </button>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">{t("entry.loading")}</div>
      )}
      {isError && (
        <div className="text-sm text-destructive">
          {t("automation.load_failed")}
        </div>
      )}

      {!isLoading && !isError && sorted.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
          <div className="text-sm font-medium">{t("automation.empty")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("automation.empty_hint")}
          </div>
        </div>
      )}

      {sorted.length > 0 && (
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-xs font-medium text-muted-foreground">
              <th className="w-12 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_enabled")}
              </th>
              <th className="w-16 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_order")}
              </th>
              <th className="w-40 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_name")}
              </th>
              <th className="w-28 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_scope")}
              </th>
              <th className="border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_conditions")}
              </th>
              <th className="w-40 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_actions")}
              </th>
              <th className="w-16 border-b border-border py-1.5 text-right font-medium">
                {t("automation.col_matches")}
              </th>
              <th className="w-36 border-b border-border py-1.5 text-left font-medium">
                {t("automation.col_last_matched")}
              </th>
              <th className="w-32 border-b border-border py-1.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((rule, index) => (
              <tr key={rule.id} className="group align-top hover:bg-accent/20">
                <td className="border-b border-border/60 py-2">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(checked) =>
                      update.mutate({
                        id: rule.id,
                        payload: {
                          ...toWritePayload(rule, rule.position),
                          enabled: checked,
                        },
                      })
                    }
                  />
                </td>
                <td className="border-b border-border/60 py-2">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      title={t("automation.move_up")}
                      disabled={index === 0}
                      onClick={() => move(rule, -1)}
                      className={cn(
                        actionButton,
                        index === 0 && "cursor-not-allowed opacity-30",
                      )}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title={t("automation.move_down")}
                      disabled={index === sorted.length - 1}
                      onClick={() => move(rule, 1)}
                      className={cn(
                        actionButton,
                        index === sorted.length - 1 &&
                          "cursor-not-allowed opacity-30",
                      )}
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td className="border-b border-border/60 py-2 pr-2">
                  <button
                    type="button"
                    onClick={() => openEdit(rule)}
                    className={cn(
                      "text-left font-medium hover:underline",
                      !rule.enabled && "text-muted-foreground",
                    )}
                  >
                    {rule.name}
                  </button>
                  {/* 规则执行失败的可见出口（webhook 投递失败 / AI 判定失败） */}
                  {rule.lastError && (
                    <div
                      title={rule.lastError}
                      className="mt-0.5 truncate text-[11px] text-destructive"
                    >
                      {rule.lastError}
                    </div>
                  )}
                </td>
                <td className="border-b border-border/60 py-2 pr-2 text-xs text-muted-foreground">
                  <span className="block truncate">{scopeLabel(rule)}</span>
                </td>
                <td className="border-b border-border/60 py-2 pr-2 text-xs text-muted-foreground">
                  <span className="block truncate font-mono">
                    {describeConditions(rule.conditions ?? [], t)}
                  </span>
                </td>
                <td className="border-b border-border/60 py-2 pr-2 text-xs">
                  {describeActions(rule.actions ?? {}, t)}
                </td>
                <td className="border-b border-border/60 py-2 text-right text-xs tabular-nums">
                  <button
                    type="button"
                    onClick={() => setMatchesRule(rule)}
                    title={t("automation.matches_title")}
                    className={cn(
                      "rounded px-1 tabular-nums transition-colors hover:bg-accent",
                      rule.matchCount > 0
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {rule.matchCount}
                  </button>
                </td>
                <td className="border-b border-border/60 py-2 text-xs text-muted-foreground">
                  {rule.lastMatchedAt
                    ? formatTime(rule.lastMatchedAt)
                    : t("automation.never_matched")}
                </td>
                <td className="border-b border-border/60 py-2 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => openEdit(rule)}
                      className={actionButton}
                    >
                      {t("automation.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevert(rule)}
                      className={actionButton}
                    >
                      {t("automation.revert")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApplyRule(rule)}
                      className={actionButton}
                    >
                      {t("automation.apply_history")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteWithRevert(true);
                        setPendingDelete(rule);
                      }}
                      className={cn(actionButton, "hover:text-destructive")}
                    >
                      {t("automation.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 筛选视图：同一套范围 + 条件，但只筛条目、不写数据，作为侧栏快捷入口 */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("automation.views_title")}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground/70">
              {t("automation.views_hint")}
            </div>
          </div>
          <button
            type="button"
            onClick={openNewView}
            className={cn(
              "h-8 shrink-0 rounded-md border border-border px-3 text-sm font-medium",
              "transition-colors hover:bg-accent",
            )}
          >
            + {t("automation.new_view")}
          </button>
        </div>

        {views.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
            {t("automation.views_empty")}
          </div>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-xs font-medium text-muted-foreground">
                <th className="w-56 border-b border-border py-1.5 text-left font-medium">
                  {t("automation.col_name")}
                </th>
                <th className="w-40 border-b border-border py-1.5 text-left font-medium">
                  {t("automation.col_scope")}
                </th>
                <th className="border-b border-border py-1.5 text-left font-medium">
                  {t("automation.col_conditions")}
                </th>
                <th className="w-24 border-b border-border py-1.5 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {views.map((view) => (
                <tr
                  key={view.id}
                  className="group align-top hover:bg-accent/20"
                >
                  <td className="border-b border-border/60 py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => openEdit(view)}
                      className="text-left font-medium hover:underline"
                    >
                      {view.name}
                    </button>
                  </td>
                  <td className="border-b border-border/60 py-2 pr-2 text-xs text-muted-foreground">
                    <span className="block truncate">{scopeLabel(view)}</span>
                  </td>
                  <td className="border-b border-border/60 py-2 pr-2 text-xs text-muted-foreground">
                    <span className="block truncate font-mono">
                      {describeConditions(view.conditions ?? [], t)}
                    </span>
                  </td>
                  <td className="border-b border-border/60 py-2 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => openEdit(view)}
                        className={actionButton}
                      >
                        {t("automation.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteWithRevert(false);
                          setPendingDelete(view);
                        }}
                        className={cn(actionButton, "hover:text-destructive")}
                      >
                        {t("automation.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 自然语言建规则：一句人话 → 规则草稿（填进编辑器，由人确认后才落库） */}
      <Dialog
        open={nlOpen}
        onOpenChange={(open) => {
          if (!open) {
            setNlOpen(false);
            setNlError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle className="text-base font-semibold">
            {t("automation.nl_title")}
          </DialogTitle>
          <div className="mt-2 text-xs text-muted-foreground">
            {t("automation.nl_hint")}
          </div>
          <textarea
            value={nlText}
            onChange={(event) => setNlText(event.target.value)}
            rows={3}
            placeholder={t("automation.nl_placeholder")}
            className={cn(
              "mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm",
              "placeholder:text-muted-foreground/50",
              "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20",
            )}
          />
          {nlError && (
            <div className="mt-2 text-xs text-destructive">{nlError}</div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setNlOpen(false);
                setNlError(null);
              }}
              className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("automation.cancel")}
            </button>
            <button
              type="button"
              disabled={nlDraft.isPending || nlText.trim().length === 0}
              onClick={handleGenerate}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {nlDraft.isPending
                ? t("automation.nl_generating")
                : t("automation.nl_generate")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 回溯确认（会改历史条目，所以先说清范围与语义再执行） */}
      <Dialog
        open={applyRule !== null}
        onOpenChange={(open) => !open && setApplyRule(null)}
      >
        <DialogContent className="max-w-md">
          <DialogTitle className="text-base font-semibold">
            {t("automation.apply_history_title")}
          </DialogTitle>
          <div className="mt-2 text-sm text-muted-foreground">
            {t("automation.apply_history_description", {
              limit: applyHistoryLimit,
            })}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setApplyRule(null)}
              className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("automation.cancel")}
            </button>
            <button
              type="button"
              disabled={applyHistory.isPending}
              onClick={() => {
                if (!applyRule) return;
                applyHistory.mutate(
                  { id: applyRule.id, limit: applyHistoryLimit },
                  {
                    onSuccess: (result) => {
                      setApplyRule(null);
                      showToast(
                        result.applied > 0
                          ? t("automation.apply_history_done", {
                              scanned: result.scanned,
                              applied: result.applied,
                            })
                          : t("automation.apply_history_none"),
                      );
                    },
                  },
                );
              }}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applyHistory.isPending
                ? t("automation.saving")
                : t("automation.apply_history_confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 命中日志（「为什么这条看不到」的答案） */}
      <FilterMatchesDialog
        rule={matchesRule}
        onClose={() => setMatchesRule(null)}
      />

      {/* 删除确认（规则可选顺带撤销；视图没有动作，不显示这个勾选框） */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogTitle className="text-base font-semibold">
            {pendingDelete?.kind === "view"
              ? t("automation.delete_view_title")
              : t("automation.delete_title")}
          </DialogTitle>
          <div className="mt-2 text-sm text-muted-foreground">
            {pendingDelete?.kind === "view"
              ? t("automation.delete_view_description")
              : t("automation.delete_description")}
          </div>
          {pendingDelete?.kind !== "view" && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteWithRevert}
                onChange={(event) => setDeleteWithRevert(event.target.checked)}
              />
              {t("automation.delete_with_revert")}
            </label>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("automation.cancel")}
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              className="h-8 rounded-md bg-destructive px-3 text-sm font-medium text-white hover:bg-destructive/90"
            >
              {t("automation.delete")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
