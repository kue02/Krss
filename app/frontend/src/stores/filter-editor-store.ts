import { create } from "zustand";
import type { Entry, Feed } from "@/types/api";
import type {
  FilterCondition,
  FilterRule,
  FilterWritePayload,
} from "@/types/filters";

/**
 * 规则编辑器（右侧抽屉）的打开状态。
 *
 * 编辑器要在三个入口被唤起 —— 设置 → 自动化、订阅右键、条目侧 —— 但它们分散在不同组件里，
 * 所以按本项目惯例（lightbox-store / image-preview-store）用一个 zustand store 承载，
 * 编辑器本身挂在 App 层，谁都能打开它。
 */

export interface FilterEditorPreset {
  /** 预填的范围（订阅右键 / 条目侧用） */
  scopeType?: FilterWritePayload["scopeType"];
  scopeId?: string;
  conditions?: FilterCondition[];
  name?: string;
}

interface FilterEditorStore {
  open: boolean;
  /** 有值 = 编辑已有规则；为空 = 新建 */
  editingId: string | null;
  draft: FilterWritePayload | null;
  openNew: () => void;
  openEdit: (rule: FilterRule) => void;
  openWithPreset: (preset: FilterEditorPreset) => void;
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
  draft: null,

  openNew: () =>
    set({ open: true, editingId: null, draft: emptyDraft() }),

  openEdit: (rule) =>
    set({
      open: true,
      editingId: rule.id,
      draft: {
        name: rule.name,
        enabled: rule.enabled,
        position: rule.position,
        scopeType: rule.scopeType,
        scopeId: rule.scopeId,
        conditions: rule.conditions ?? [],
        actions: rule.actions ?? {},
      },
    }),

  openWithPreset: (preset) =>
    set({ open: true, editingId: null, draft: emptyDraft(preset) }),

  close: () => set({ open: false, editingId: null, draft: null }),
}));

/** 订阅右键 → 为此订阅新建规则 */
export function openFilterEditorForFeed(feed: Feed): void {
  useFilterEditorStore.getState().openWithPreset({
    scopeType: "feed",
    scopeId: feed.id,
    name: feed.title ? `${feed.title}` : "",
  });
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
