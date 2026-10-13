import { create } from "zustand";
import type { Entry, Feed } from "@/types/api";
import type {
  FilterCondition,
  FilterDraft,
  FilterKind,
  FilterRule,
  FilterWritePayload,
} from "@/types/filters";
import type { ContentType } from "@/types/api";

/**
 * 规则编辑器（右侧抽屉）的打开状态。
 *
 * 编辑器要在四个入口被唤起 —— 设置 → 自动化、订阅右键、条目侧、自然语言建规则 ——
 * 但它们分散在不同组件里，所以按本项目惯例（lightbox-store / image-preview-store）用一个
 * zustand store 承载，编辑器本身挂在 App 层，谁都能打开它。
 *
 * kind = "view" 时是「保存筛选视图」的编辑器：同一套范围 + 条件，但没有动作区。
 */

export interface FilterEditorPreset {
  /** 预填的范围（订阅右键 / 条目侧用） */
  scopeType?: FilterWritePayload["scopeType"];
  scopeId?: string;
  /** 多选订阅（用户 11-16）：范围 = 订阅时可多选多个源 */
  scopeIds?: string[];
  /** 视图只在哪些内容类型下显示（用户 11-5） */
  contentTypes?: ContentType[];
  /** 视图自定义图标（用户 11-5） */
  icon?: string;
  conditions?: FilterCondition[];
  name?: string;
}

interface FilterEditorStore {
  open: boolean;
  /** 有值 = 编辑已有规则；为空 = 新建 */
  editingId: string | null;
  /** 正在编辑的是规则还是视图（决定标题、有没有动作区、保存时带的 kind） */
  kind: FilterKind;
  /** 自然语言建规则给出的解释与被修正项（只在刚生成后显示） */
  draftNotes: string | null;
  draftWarnings: string[];
  draft: FilterWritePayload | null;
  openNew: () => void;
  openNewView: () => void;
  openEdit: (rule: FilterRule, mergeNote?: string) => void;
  openWithPreset: (preset: FilterEditorPreset) => void;
  /** 自然语言建规则：把模型给的草稿填进编辑器，用户过一眼再保存 */
  openWithDraft: (draft: FilterDraft) => void;
  close: () => void;
}

function emptyDraft(preset?: FilterEditorPreset): FilterWritePayload {
  return {
    name: preset?.name ?? "",
    scopeType: preset?.scopeType ?? "all",
    scopeId: preset?.scopeId,
    conditions: preset?.conditions ?? [],
    actions: {},
  };
}

/** 取标题开头一小段做 contains 条件（「按此条建规则」的预填） */
function titleFragment(title?: string): string {
  if (!title) return "";
  const trimmed = title.trim();
  return trimmed.length > 16 ? trimmed.slice(0, 16) : trimmed;
}

export const useFilterEditorStore = create<FilterEditorStore>((set) => ({
  open: false,
  editingId: null,
  kind: "rule",
  draftNotes: null,
  draftWarnings: [],
  draft: null,

  openNew: () =>
    set({
      open: true,
      editingId: null,
      kind: "rule",
      draftNotes: null,
      draftWarnings: [],
      draft: emptyDraft(),
    }),

  openNewView: () =>
    set({
      open: true,
      editingId: null,
      kind: "view",
      draftNotes: null,
      draftWarnings: [],
      draft: emptyDraft(),
    }),

  openEdit: (rule, mergeNote) =>
    set({
      open: true,
      editingId: rule.id,
      kind: rule.kind === "view" ? "view" : "rule",
      // 51 批 A7：右键「新建规则」命中已有规则时带「已并入」提示（复用 draftNotes 展示位）
      draftNotes: mergeNote ?? null,
      draftWarnings: [],
      draft: {
        name: rule.name,
        enabled: rule.enabled,
        position: rule.position,
        kind: rule.kind === "view" ? "view" : "rule",
        scopeType: rule.scopeType,
        scopeId: rule.scopeId,
        scopeIds: rule.scopeIds,
        contentTypes: rule.contentTypes,
        icon: rule.icon,
        conditions: rule.conditions ?? [],
        actions: rule.actions ?? {},
      },
    }),

  openWithPreset: (preset) =>
    set({
      open: true,
      editingId: null,
      kind: "rule",
      draftNotes: null,
      draftWarnings: [],
      draft: emptyDraft(preset),
    }),

  openWithDraft: (draft) =>
    set({
      open: true,
      editingId: null,
      kind: "rule",
      draftNotes: draft.notes?.trim() ? draft.notes : null,
      draftWarnings: draft.warnings ?? [],
      draft: {
        name: draft.name,
        scopeType: draft.scopeType,
        scopeId: draft.scopeId,
        scopeIds: draft.scopeIds,
        contentTypes: draft.contentTypes,
        icon: draft.icon,
        kind: "rule",
        conditions: draft.conditions ?? [],
        actions: draft.actions ?? {},
      },
    }),

  close: () =>
    set({
      open: false,
      editingId: null,
      kind: "rule",
      draftNotes: null,
      draftWarnings: [],
      draft: null,
    }),
}));

/** 订阅右键 → 为此订阅新建规则 */
export function openFilterEditorForFeed(
  feed: Feed,
  existingRules?: FilterRule[],
  mergeNotePrefix?: string,
): void {
  // 51 批 A7（用户拍板）：同订阅已有规则时不再新建，打开 position 最靠前的那条累加，
  // 避免「每按一次右键就多一条单条件同订阅规则」的堆积。只算规则（kind=rule），
  // 视图（kind=view）是筛选视图不是执行规则，不并。多选订阅（scopeIds）不算「钉在这个订阅」。
  const reusable = (existingRules ?? [])
    .filter(
      (item) =>
        (item.kind ?? "rule") === "rule" &&
        item.scopeType === "feed" &&
        item.scopeId === feed.id &&
        !(item.scopeIds && item.scopeIds.length > 0),
    )
    .sort((a, b) => a.position - b.position)[0];
  if (reusable) {
    useFilterEditorStore
      .getState()
      .openEdit(reusable, formatMergeNote(mergeNotePrefix, reusable.name));
    return;
  }
  useFilterEditorStore.getState().openWithPreset({
    scopeType: "feed",
    scopeId: feed.id,
    name: feed.title ? `${feed.title}` : "",
  });
}

/** 51 批 A7：文件夹右键「为此文件夹新建规则」—— 同样的「已有则并入第一条」逻辑 */
export function openFilterEditorForFolder(
  folder: { id: string; name: string },
  existingRules?: FilterRule[],
  mergeNotePrefix?: string,
): void {
  const reusable = (existingRules ?? [])
    .filter(
      (item) =>
        (item.kind ?? "rule") === "rule" &&
        item.scopeType === "folder" &&
        item.scopeId === folder.id,
    )
    .sort((a, b) => a.position - b.position)[0];
  if (reusable) {
    useFilterEditorStore
      .getState()
      .openEdit(reusable, formatMergeNote(mergeNotePrefix, reusable.name));
    return;
  }
  useFilterEditorStore.getState().openWithPreset({
    scopeType: "folder",
    scopeId: folder.id,
    name: folder.name,
  });
}

/** 51 批 A7：并入提示 = 调用方给的前缀（i18n 在组件层做，store 保持可测试）+ 规则名 */
function formatMergeNote(prefix: string | undefined, ruleName: string): string {
  if (!prefix) return ruleName;
  return `${prefix}《${ruleName}》`;
}

/** 条目侧 → 按此条新建规则（用作者或标题片段预填条件） */
export function openFilterEditorForEntry(entry: Entry): void {
  const conditions: FilterCondition[] = [];
  if (entry.author) {
    conditions.push({
      field: "author",
      operator: "exact",
      value: entry.author,
    });
  }
  const fragment = titleFragment(entry.title);
  if (fragment) {
    conditions.push({
      logic: entry.author ? "or" : undefined,
      field: "title",
      operator: "contains",
      value: fragment,
    });
  }
  useFilterEditorStore.getState().openWithPreset({
    scopeType: "feed",
    scopeId: entry.feedId,
    conditions,
  });
}
