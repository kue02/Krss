import { useEffect } from "react";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";

export interface GlobalHotkeysOptions {
  /** ? 显示/隐藏快捷键帮助 */
  onToggleHelp?: () => void;
  /** r 刷新全部订阅 */
  onRefresh?: () => void;
  /** f 或 ⌘/Ctrl+K 打开搜索（对齐 NextFlux 的 f） */
  onSearch?: () => void;
  enabled?: boolean;
}

/**
 * 全局快捷键（与列表内的 useEntryHotkeys 键位不重叠）
 *
 * ?      显示/隐藏快捷键帮助
 * r      刷新订阅
 * f / ⌘K 搜索
 */
export function useGlobalHotkeys({
  onToggleHelp,
  onRefresh,
  onSearch,
  enabled = true,
}: GlobalHotkeysOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      // 搜索用 ⌘/Ctrl+K 也开（带修饰键，要在「裸键」判定之前拦）
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onSearch?.();
        return;
      }

      if (!isPlainKey(event)) return;

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        onSearch?.();
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        onToggleHelp?.();
        return;
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        onRefresh?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onToggleHelp, onRefresh, onSearch]);
}
