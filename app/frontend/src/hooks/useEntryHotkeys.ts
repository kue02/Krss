import { useEffect } from "react";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";
import type { Entry } from "@/types/api";

export interface EntryHotkeysOptions {
  /** 当前列表里的文章（顺序即 j/k 的移动顺序） */
  entries: Entry[];
  selectedEntryId: string | null;
  /** 选中某篇（通常传 EntryList 的 handleSelectEntry，会顺带记住滚动位置） */
  onSelect: (entryId: string) => void;
  /** Esc：关闭详情（移动端/平板返回列表），可选 */
  onEscape?: () => void;
  /** 列表不可见时（例如移动端正在读文章）不要抢键 */
  enabled?: boolean;
  /**
   * 是否也认 ↑/↓（默认 **false**）。
   *
   * 15-4（通知视图 · 时间线）要的「沿轴选择」是 j/k、↑/↓ 都能在节点间吸附；
   * 但其余视图此前并不认 ↑/↓，默认开着等于改既有行为 —— 所以由调用方显式打开，
   * 只有时间线视图传 true。
   */
  arrowKeys?: boolean;
}

/**
 * 文章列表的键盘快捷键（对齐 Nextflux 的 useHotkeys）
 *
 * j / k  下一篇 / 上一篇（选中即标记已读，与 Nextflux 一致）
 * m      切换当前文章的已读状态
 * s      切换星标
 * v      在浏览器中打开原文
 * Esc    关闭详情
 *
 * 说明：焦点在输入框/可编辑区域时一律不抢键；带 Ctrl/Cmd/Alt 的组合键也放行给浏览器。
 */
export function useEntryHotkeys({
  entries,
  selectedEntryId,
  onSelect,
  onEscape,
  enabled = true,
  arrowKeys = false,
}: EntryHotkeysOptions) {
  const markAsRead = useMarkAsRead();
  const markAsStarred = useMarkAsStarred();

  useEffect(() => {
    if (!enabled) return;

    const revealEntry = (entryId: string) => {
      // 键盘移动后让选中项留在视口内（列表是虚拟化无关的普通滚动容器）
      const node = document.querySelector<HTMLElement>(
        `[data-entry-id="${entryId}"]`,
      );
      node?.scrollIntoView({ block: "nearest" });
    };

    const selectAndMarkRead = (entry: Entry) => {
      onSelect(entry.id);
      revealEntry(entry.id);
      if (!entry.read) {
        markAsRead.mutate({ id: entry.id, read: true });
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (!isPlainKey(event)) return;

      const currentIndex = selectedEntryId
        ? entries.findIndex((item) => item.id === selectedEntryId)
        : -1;
      const current = currentIndex >= 0 ? entries[currentIndex] : null;

      switch (event.key.toLowerCase()) {
        // ↓ / ↑ 与 j / k 同义 —— 但只在调用方显式打开时（时间线视图，见 arrowKeys）
        case "j":
        case "arrowdown": {
          if (event.key.startsWith("Arrow") && !arrowKeys) return;
          const next = entries[currentIndex + 1] ?? (currentIndex < 0 ? entries[0] : undefined);
          if (!next) return;
          event.preventDefault();
          selectAndMarkRead(next);
          break;
        }
        case "k":
        case "arrowup": {
          if (event.key.startsWith("Arrow") && !arrowKeys) return;
          if (currentIndex <= 0) return;
          const previous = entries[currentIndex - 1];
          if (!previous) return;
          event.preventDefault();
          selectAndMarkRead(previous);
          break;
        }
        case "m": {
          if (!current) return;
          event.preventDefault();
          markAsRead.mutate({ id: current.id, read: !current.read });
          break;
        }
        case "s": {
          if (!current) return;
          event.preventDefault();
          markAsStarred.mutate({ id: current.id, starred: !current.starred });
          break;
        }
        case "v": {
          if (!current?.url) return;
          event.preventDefault();
          window.open(current.url, "_blank", "noopener,noreferrer");
          break;
        }
        case "escape": {
          if (!selectedEntryId || !onEscape) return;
          event.preventDefault();
          onEscape();
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    enabled,
    entries,
    selectedEntryId,
    onSelect,
    onEscape,
    arrowKeys,
    markAsRead,
    markAsStarred,
  ]);
}
