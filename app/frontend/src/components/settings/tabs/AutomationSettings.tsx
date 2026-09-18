import { useCallback, useMemo, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertDialog, Button, Checkbox, Dropdown, Label, Modal, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { GripVerticalIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useFilterViewStore } from "@/stores/filter-view-store";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
import { Switch } from "@/components/ui/switch";
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
import { RevertFilterDialog } from "@/components/automation/RevertFilterDialog";
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

/** 范围 / 命中数这类「贴纸」：细边小字，不是按钮（Compact 但要能扫） */
function Badge({
  children,
  tone = "muted",
  title,
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 rounded-[4px] border px-1.5 py-px text-[11px] font-medium leading-4",
        tone === "danger"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border/60 bg-secondary/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** 行尾「⋯」菜单：把次要操作收进去，行内只留能扫的信息 */
function RowMenu({
  items,
  label,
}: {
  items: {
    id: string;
    label: string;
    onSelect: () => void;
    danger?: boolean;
    /** 置灰项（例如首行的「上移」）——react-aria 会同时给 aria-disabled */
    disabled?: boolean;
  }[];
  label: string;
}) {
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={label}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-[var(--radius)]",
          "text-muted-foreground transition-colors",
          "hover:bg-secondary hover:text-foreground data-[pressed]:bg-secondary",
        )}
      >
        <MoreHorizontal className="size-4" />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => {
            items.find((item) => item.id === key)?.onSelect();
          }}
        >
          {items.map((item) => (
            <Dropdown.Item
              key={item.id}
              id={item.id}
              textValue={item.label}
              variant={item.danger ? "danger" : undefined}
              isDisabled={item.disabled ? true : undefined}
            >
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}


/**
 * 一条规则行。
 *
 * 抽成组件是因为**拖动要按行持有 dragControls**（`dragListener={false}` + 把手启动拖动，
 * 否则开关、名称、命中数这些可点区域都会跟拖动抢事件）。
 *
 * 顺序即优先级（首个命中即停），所以拖动结果必须落库；行尾菜单里保留「上移 / 下移」，
 * 键盘用户与不想拖的人还能用（用户要求主交互改成拖动，所以行内不再摆 ↑↓ 两颗按钮）。
 */
function RuleRow({
  rule,
  scope,
  index,
  total,
  onToggle,
  onEdit,
  onMove,
  onShowMatches,
  onApplyHistory,
  onRevert,
  onDelete,
}: {
  rule: FilterRule;
  /** 范围文案由父组件算好传进来（订阅名 / 分类名 / 全部） */
  scope: string;
  index: number;
  total: number;
  onToggle: (checked: boolean) => void;
  onEdit: () => void;
  onMove: (offset: number) => void;
  onShowMatches: () => void;
  onApplyHistory: () => void;
  onRevert: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={rule}
      dragListener={false}
      dragControls={dragControls}
      className="flex items-start gap-2 px-2 py-2.5 transition-colors hover:bg-secondary/25"
    >
      {/* 拖动把手：拖动排序的主入口（只在把手上按下才拖，不会跟行内点击抢事件） */}
      <button
        type="button"
        aria-label={t("automation.drag_handle")}
        title={t("automation.order_hint")}
        onPointerDown={(event) => dragControls.start(event)}
        className={cn(
          "mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/60",
          "transition-colors hover:bg-secondary hover:text-foreground active:cursor-grabbing",
        )}
      >
        <GripVerticalIcon className="size-4" />
      </button>

      <Switch className="mt-0.5" checked={rule.enabled} onCheckedChange={onToggle} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={onEdit}
            className={cn(
              "max-w-full truncate text-sm font-medium hover:underline",
              !rule.enabled && "text-muted-foreground",
            )}
          >
            {rule.name}
          </button>
          <Badge>{scope}</Badge>
          {!rule.enabled && <Badge>{t("automation.enabled_hint")}</Badge>}
          {rule.lastError && (
            <Badge tone="danger" title={rule.lastError}>
              {t("automation.failed_badge")}
            </Badge>
          )}
        </div>

        {/* 12-8：条件/动作在左列，「命中」固定在右列 —— 两行的 x 位置跨行一致，才跟上面的列对得齐 */}
        <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="max-w-full truncate font-mono">
            {describeConditions(rule.conditions ?? [], t)}
          </span>
          <span className="text-border">→</span>
          <span className="min-w-0 truncate">
            {describeActions(rule.actions ?? {}, t)}
          </span>
        </div>

        {rule.lastError && (
          <div
            title={rule.lastError}
            className="mt-1 truncate text-[11px] text-destructive"
          >
            {rule.lastError}
          </div>
        )}

        {/*
          命中 / 最近命中原来是两截：只有「命中 N」是按钮、「最近命中」是死文字，
          用户看不出整块能点（11-17）。现在整块收进一个 HeroUI Button，配 chevron 当可点信号，
          hover 有底色，tooltip 说清点了会看到什么。
        */}
        <div className="flex items-center justify-end text-[11px]">
          <Tooltip>
            <TooltipTrigger>
              <Button
                size="sm"
                variant="ghost"
                onPress={onShowMatches}
                className="h-6 gap-1.5 px-1.5 text-[11px] font-normal tabular-nums"
              >
                <span
                  className={cn(
                    "font-medium",
                    rule.matchCount > 0
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {t("automation.hits", { count: rule.matchCount })}
                </span>
                <span className="text-border">·</span>
                <span
                  className={
                    rule.lastMatchedAt
                      ? "text-foreground/80"
                      : "text-muted-foreground"
                  }
                >
                  {rule.lastMatchedAt
                    ? t("automation.last_matched", {
                        time: formatTime(rule.lastMatchedAt),
                      })
                    : t("automation.never_matched")}
                </span>
                <ChevronRight className="size-3.5 opacity-50" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("automation.matches_title")}</TooltipContent>
          </Tooltip>
        </div>
        </div>
      </div>

      <RowMenu
        label={t("automation.more_actions")}
        items={[
          {
            id: "move_up",
            label: t("automation.move_up"),
            disabled: index === 0,
            onSelect: () => onMove(-1),
          },
          {
            id: "move_down",
            label: t("automation.move_down"),
            disabled: index === total - 1,
            onSelect: () => onMove(1),
          },
          { id: "edit", label: t("automation.edit"), onSelect: onEdit },
          {
            id: "matches",
            label: t("automation.matches_title"),
            onSelect: onShowMatches,
          },
          {
            id: "apply",
            label: t("automation.apply_history"),
            onSelect: onApplyHistory,
          },
          { id: "revert", label: t("automation.revert"), onSelect: onRevert },
          {
            id: "delete",
            label: t("automation.delete"),
            danger: true,
            onSelect: onDelete,
          },
        ]}
      />
    </Reorder.Item>
  );
}

/**
 * 设置 → 自动化 —— **纯管理页**：管规则、管视图、看已静音。
 *
 * 2026-09-17 重做（用户：原来那版是「UI 地狱」，一屏塞 8 列看不清）。改动要点：
 *   - 一条规则 = 两行：第一行「开关 + 名称 + 范围 + 状态」，第二行「条件 → 动作 + 命中/最近命中」；
 *     不再为了对齐列宽把名字、条件、动作全挤成省略号（原来 table-fixed 到看不清）
 *   - 行内只留开关与 ↑↓；编辑 / 命中记录 / 回溯历史 / 撤销影响 / 删除 全部收进行尾「⋯」
 *   - 规则与视图分成两段，各带数量；视图不执行动作，所以没有开关与回溯
 *   - 执行失败（webhook 投递失败 / AI 判定失败）在行内以红字 + tooltip 明示，不再只是「有个东西没跑成」
 *   - 弹窗全部换成 HeroUI（Modal / AlertDialog），顺手解决 Radix 那条
 *     「Missing Description or aria-describedby for DialogContent」告警
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
  // revert 现在由 RevertFilterDialog 自己调（要带勾选项），这里不再直接用
  const { update, remove } = useFilterMutations();
  const applyHistory = useApplyFilterHistory();
  const nlDraft = useFilterDraft();
  const openNew = useFilterEditorStore((state) => state.openNew);
  const openNewView = useFilterEditorStore((state) => state.openNewView);
  const openEdit = useFilterEditorStore((state) => state.openEdit);
  const openWithDraft = useFilterEditorStore((state) => state.openWithDraft);

  const [revertRule, setRevertRule] = useState<FilterRule | null>(null);
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

  /**
   * 拖动排序的落库。
   *
   * 顺序即优先级（首个命中即停），所以拖动结果必须写回后端；按新顺序重编号 0..n-1，
   * 但**只提交位置真的变了的那些** —— 一次拖动通常只影响其中一段，没必要整表重写。
   * （例外规则那种 position 为负的「永远最先」是靠排到最前实现的，重编号后它仍在最前，语义不变。）
   */
  const handleReorder = useCallback(
    (next: FilterRule[]) => {
      next.forEach((rule, index) => {
        if (rule.position === index) return;
        update.mutate({ id: rule.id, payload: toWritePayload(rule, index) });
      });
    },
    [update],
  );

  // 撤销影响：先拉影响清单让人勾选（用户 11-23），不再是「一点就全撤」
  const handleRevert = (rule: FilterRule) => {
    setRevertRule(rule);
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

  /** 段标题：紧凑但不能只是灰字（要能一眼数出有几条） */
  const sectionHeader = (label: string, count: number, action?: React.ReactNode) => (
    <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>
      </div>
      {action}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 顶栏工具条 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs leading-relaxed text-muted-foreground">
            {t("automation.subtitle")}
          </div>
          {sorted.length > 1 && (
            <div className="mt-0.5 text-xs text-muted-foreground/70">
              {t("automation.order_hint")}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="rounded-[var(--radius)] border border-border"
            onPress={() => {
              setNlError(null);
              setNlOpen(true);
            }}
          >
            {t("automation.nl_open")}
          </Button>
          <Button size="sm" variant="primary" onPress={openNew}>
            + {t("automation.new_rule")}
          </Button>
        </div>
      </div>

      {/* 「已静音」回看入口 —— 被规则静音的东西是个回看角落，不该占中栏的高位入口；
          放在自动化页也顺手回答了「它为什么被静音」（规则都在这一页） */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("automation.muted_entries")}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t("automation.muted_entries_hint")}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 rounded-[var(--radius)] border border-border"
          onPress={() => {
            clearView();
            setMutedOnly(true);
            closeSettings();
          }}
        >
          {t("automation.muted_entries_open")}
        </Button>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">{t("entry.loading")}</div>
      )}
      {isError && (
        <div className="text-sm text-destructive">{t("automation.load_failed")}</div>
      )}

      {/* 规则 */}
      <section>
        {sectionHeader(t("automation.rules_title"), sorted.length)}
        {!isLoading && !isError && sorted.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
            <div className="text-sm font-medium">{t("automation.empty")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("automation.empty_hint")}
            </div>
          </div>
        ) : (
          <Reorder.Group
            as="div"
            axis="y"
            values={sorted}
            onReorder={handleReorder}
            className="divide-y divide-border/60 rounded-md border border-border/60"
          >
            {sorted.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                scope={scopeLabel(rule)}
                index={index}
                total={sorted.length}
                onToggle={(checked) =>
                  update.mutate({
                    id: rule.id,
                    payload: {
                      ...toWritePayload(rule, rule.position),
                      enabled: checked,
                    },
                  })
                }
                onEdit={() => openEdit(rule)}
                onMove={(offset) => move(rule, offset)}
                onShowMatches={() => setMatchesRule(rule)}
                onApplyHistory={() => setApplyRule(rule)}
                onRevert={() => handleRevert(rule)}
                onDelete={() => {
                  setDeleteWithRevert(true);
                  setPendingDelete(rule);
                }}
              />
            ))}
          </Reorder.Group>
        )}
      </section>

      {/* 筛选视图：同一套范围 + 条件，但只筛条目、不写数据，作为侧栏快捷入口 */}
      <section>
        {sectionHeader(
          t("automation.views_title"),
          views.length,
          <Button
            size="sm"
            variant="ghost"
            className="rounded-[var(--radius)] border border-border"
            onPress={openNewView}
          >
            + {t("automation.new_view")}
          </Button>,
        )}
        <div className="mb-1.5 px-1 text-xs text-muted-foreground/70">
          {t("automation.views_hint")}
        </div>
        {views.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
            {t("automation.views_empty")}
          </div>
        ) : (
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {views.map((view) => (
              <div
                key={view.id}
                className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-secondary/25"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    type="button"
                    onClick={() => openEdit(view)}
                    className="max-w-full truncate text-sm font-medium hover:underline"
                  >
                    {view.name}
                  </button>
                  <Badge>{scopeLabel(view)}</Badge>
                  <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
                    {describeConditions(view.conditions ?? [], t)}
                  </span>
                </div>
                <RowMenu
                  label={t("automation.more_actions")}
                  items={[
                    {
                      id: "edit",
                      label: t("automation.edit"),
                      onSelect: () => openEdit(view),
                    },
                    {
                      id: "delete",
                      label: t("automation.delete"),
                      danger: true,
                      onSelect: () => {
                        setDeleteWithRevert(false);
                        setPendingDelete(view);
                      },
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 自然语言建规则：一句人话 → 规则草稿（填进编辑器，由人确认后才落库） */}
      <Modal>
        <Button className="hidden" aria-hidden />
        <Modal.Backdrop
          isOpen={nlOpen}
          onOpenChange={(open) => {
            if (!open) {
              setNlOpen(false);
              setNlError(null);
            }
          }}
        >
          <Modal.Container>
            <Modal.Dialog className="max-w-lg">
              <Modal.Header>
                <Modal.Heading>{t("automation.nl_title")}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="text-xs text-muted-foreground">
                  {t("automation.nl_hint")}
                </div>
                <textarea
                  value={nlText}
                  onChange={(event) => setNlText(event.target.value)}
                  rows={3}
                  placeholder={t("automation.nl_placeholder")}
                  className={cn(
                    "mt-2 w-full rounded-field border border-border bg-background px-2 py-1.5 text-sm",
                    "placeholder:text-muted-foreground/50",
                    "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20",
                  )}
                />
                {nlError && (
                  <div className="mt-2 text-xs text-destructive">{nlError}</div>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setNlOpen(false);
                    setNlError(null);
                  }}
                >
                  {t("automation.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={nlDraft.isPending || nlText.trim().length === 0}
                  onPress={handleGenerate}
                >
                  {nlDraft.isPending
                    ? t("automation.nl_generating")
                    : t("automation.nl_generate")}
                </Button>
              </Modal.Footer>
              <Modal.CloseTrigger />
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* 回溯确认（会改历史条目，所以先说清范围与语义再执行） */}
      <Modal>
        <Button className="hidden" aria-hidden />
        <Modal.Backdrop
          isOpen={applyRule !== null}
          onOpenChange={(open) => !open && setApplyRule(null)}
        >
          <Modal.Container>
            <Modal.Dialog className="max-w-md">
              <Modal.Header>
                <Modal.Heading>
                  {t("automation.apply_history_title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="text-sm text-muted-foreground">
                  {t("automation.apply_history_description", {
                    limit: applyHistoryLimit,
                  })}
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setApplyRule(null)}
                >
                  {t("automation.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={applyHistory.isPending}
                  onPress={() => {
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
                >
                  {applyHistory.isPending
                    ? t("automation.saving")
                    : t("automation.apply_history_confirm")}
                </Button>
              </Modal.Footer>
              <Modal.CloseTrigger />
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* 撤销影响：先给清单，勾选后只撤勾选的 */}
      <RevertFilterDialog
        rule={revertRule}
        onClose={() => setRevertRule(null)}
      />

      {/* 命中日志（「为什么这条看不到」的答案） */}
      <FilterMatchesDialog
        rule={matchesRule}
        onClose={() => setMatchesRule(null)}
      />

      {/* 删除确认（规则可选顺带撤销；视图没有动作，不显示这个勾选框） */}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={pendingDelete !== null}
          onOpenChange={(open) => !open && setPendingDelete(null)}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-md">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {pendingDelete?.kind === "view"
                    ? t("automation.delete_view_title")
                    : t("automation.delete_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {pendingDelete?.kind === "view"
                    ? t("automation.delete_view_description")
                    : t("automation.delete_description")}
                </div>
                {pendingDelete?.kind !== "view" && (
                  /* 12-20：这里原来是原生 <input type="checkbox">（自己画的），
                     换成 HeroUI `Checkbox` —— 与「撤销影响」弹层里那个勾选框同一套（RevertFilterDialog）。
                     `flex-row` 不能省：`.checkbox` 在组件层写死 flex-direction:column，
                     不顶掉的话勾选框与文字会上下叠成两行（真机实测，13-2 同一个坑）。 */
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <Checkbox
                      isSelected={deleteWithRevert}
                      onChange={setDeleteWithRevert}
                      className="flex flex-row items-center gap-2"
                    >
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Checkbox.Content>
                        {t("automation.delete_with_revert")}
                      </Checkbox.Content>
                    </Checkbox>
                  </label>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setPendingDelete(null)}
                >
                  {t("automation.cancel")}
                </Button>
                <Button size="sm" variant="danger" onPress={confirmDelete}>
                  {t("automation.delete")}
                </Button>
              </AlertDialog.Footer>
              <AlertDialog.CloseTrigger />
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}
