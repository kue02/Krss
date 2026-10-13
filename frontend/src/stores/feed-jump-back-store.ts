import { create } from "zustand";
import type { SelectionType } from "@/hooks/useSelection";

/**
 * 52-4（用户第 4 条）：点条目的**订阅源名称/图标** → 第一栏跳到该订阅并选中，
 * 同时给一个「返回」按钮回到跳转前的样子（上一次选中的可能是文件夹、全部、星标）。
 *
 * 为什么存在 store 而不是 URL：
 * 「跳回上一个选中」是一次性的会话内动作，进地址栏会让 `/feed/:id` 长出第二个含义
 * （到底是"我点的订阅"还是"我从某处跳来的"），返回语义也会随刷新丢失得莫名其妙。
 * 这里只记「跳转前的 selection」，返回一次就清空。
 */
interface FeedJumpBackState {
  /**
   * 跳转那一刻的**完整地址**（含 `?unread&type`，也可能带着当时打开的条目 id）。
   * 存地址而不是存 selection：用户要的是「回到原本的样子」，
   * selection 只表达选中哪一档，还原不了当时正看着的那条详情。
   */
  previousHref: string | null;
  /** 这次跳来自哪个订阅：当前选中一离开它，返回按钮就该收掉（不残留） */
  fromFeedId: string | null;
  remember: (previousHref: string, fromFeedId: string) => void;
  clear: () => void;
}

export const useFeedJumpBackStore = create<FeedJumpBackState>((set) => ({
  previousHref: null,
  fromFeedId: null,
  remember: (previousHref, fromFeedId) => set({ previousHref, fromFeedId }),
  clear: () => set({ previousHref: null, fromFeedId: null }),
}));

/**
 * 已经在某个订阅上时，从条目再点进**同一个**订阅不算跳转，别记返回态
 * （否则返回按钮会指向一个「和现在一模一样」的选中态，点了像没反应）。
 */
export function isSameSelection(
  a: SelectionType | null,
  b: SelectionType,
): boolean {
  if (!a) return false;
  if (a.type !== b.type) return false;
  if (a.type === "feed" && b.type === "feed") return a.feedId === b.feedId;
  if (a.type === "folder" && b.type === "folder") return a.folderId === b.folderId;
  if (a.type === "starred" && b.type === "starred") {
    return Boolean(a.viewOnly) === Boolean(b.viewOnly);
  }
  return true;
}
