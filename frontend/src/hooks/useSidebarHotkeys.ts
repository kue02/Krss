import { useEffect } from "react";
import { isCategoryOpen, toggleCategory } from "@/hooks/useCategoryState";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";
import type { SelectionType } from "@/hooks/useSelection";

export type SidebarTarget =
  | { kind: "folder"; id: string; name: string }
  | { kind: "feed"; id: string; name: string; folderId?: string | null };

export interface SidebarHotkeysOptions {
  /** 侧栏里可导航的目标，顺序即视觉顺序（分组 → 组内订阅 → 未分组订阅） */
  targets: SidebarTarget[];
  selection: SelectionType;
  onSelectFeed: (feedId: string) => void;
  onSelectFolder: (folderId: string) => void;
  /** Shift+N：添加订阅 */
  onAddFeed?: () => void;
  enabled?: boolean;
}

/** 当前选中项在导航目标里的下标（没有选中则为 -1） */
function currentTargetIndex(
  targets: SidebarTarget[],
  selection: SelectionType,
): number {
  if (selection.type === "feed") {
    return targets.findIndex(
      (target) => target.kind === "feed" && target.id === selection.feedId,
    );
  }
  if (selection.type === "folder") {
    return targets.findIndex(
      (target) => target.kind === "folder" && target.id === selection.folderId,
    );
  }
  return -1;
}

/**
 * 侧栏快捷键（对齐 Nextflux 的 useSidebarNavigation）
 *
 * n / p  下一个 / 上一个订阅或分组（循环）
 * x      展开 / 折叠当前所在分组（选中分组本身时即该分组；选中订阅时是它所属分组）
 * Shift+N 添加订阅
 */
export function useSidebarHotkeys({
  targets,
  selection,
  onSelectFeed,
  onSelectFolder,
  onAddFeed,
  enabled = true,
}: SidebarHotkeysOptions) {
  useEffect(() => {
    if (!enabled) return;

    const selectTarget = (target: SidebarTarget) => {
      if (target.kind === "folder") {
        onSelectFolder(target.id);
      } else {
        onSelectFeed(target.id);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      // Shift+N：添加订阅（大小写敏感，先判掉，避免被下面的裸键分支吃掉）
      if (event.shiftKey && event.key.toLowerCase() === "n") {
        if (!onAddFeed || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        onAddFeed();
        return;
      }

      if (!isPlainKey(event) || event.shiftKey) return;

      const index = currentTargetIndex(targets, selection);
      const key = event.key.toLowerCase();

      if (key === "n" || key === "p") {
        if (targets.length === 0) return;
        event.preventDefault();
        const step = key === "n" ? 1 : -1;
        const nextIndex =
          index < 0
            ? key === "n"
              ? 0
              : targets.length - 1
            : (index + step + targets.length) % targets.length;
        const next = targets[nextIndex];
        if (next) selectTarget(next);
        return;
      }

      if (key === "x") {
        // 选中的是订阅时，折叠它所属的分组
        const target =
          index >= 0
            ? targets[index]
            : targets.find(
                (item) =>
                  item.kind === "feed" &&
                  selection.type === "feed" &&
                  item.id === selection.feedId,
              );
        const folderName =
          target?.kind === "folder"
            ? target.name
            : target?.kind === "feed"
              ? targets.find(
                  (item) =>
                    item.kind === "folder" && item.id === target.folderId,
                )?.name
              : undefined;
        if (!folderName) return;
        event.preventDefault();
        toggleCategory(folderName);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    enabled,
    targets,
    selection,
    onSelectFeed,
    onSelectFolder,
    onAddFeed,
  ]);
}

export { isCategoryOpen };
