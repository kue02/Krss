import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useFilterMatches } from "@/hooks/useFilters";
import { describeActions, type FilterRule } from "@/types/filters";

interface FilterMatchesDialogProps {
  /** 为 null 时不显示（关掉后由父组件清空） */
  rule: FilterRule | null;
  onClose: () => void;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * 命中日志 —— 「为什么这条看不到」的答案。
 *
 * 规则行里的命中数点开就是它：按时间倒序列出这条规则处理过的条目（条目标题 + 来源 +
 * 当时执行的动作）。条目被删掉后日志仍在，标题为空时显示占位文案。
 *
 * 2026-09-17：弹出层曾从项目自绘 Radix Dialog 换成 HeroUI `Modal`，理由是控制台报
 * 「Missing Description or aria-describedby for DialogContent」；同时把三列表格改成
 * 「时间 + 标题/来源 + 动作」的两行式列表 —— 在弹窗这种窄容器里，表格列宽一挤就没法读。
 *
 * 2026-09-18：**换回项目自己的 Dialog（Radix）**。那个 a11y 报错已经在
 * `@/components/ui/dialog` 里用视觉隐藏的 `DialogDescription` 兜掉了；而 HeroUI `Modal`
 * 的内容被 portal 到 `document.body`，落在外层设置弹窗的 `react-remove-scroll` shard 之外
 * —— 滚轮事件被 `preventDefault()` 吃掉，命中记录一多就「滚不动」（代理覆盖管理弹窗踩过同一个坑，
 * 取证与结论见 docs/dev/移植笔记.md 14 批那条）。
 */
export function FilterMatchesDialog({
  rule,
  onClose,
}: FilterMatchesDialogProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useFilterMatches(rule?.id ?? null, 100);
  const matches = data ?? [];

  return (
    <Dialog open={Boolean(rule)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] w-[720px] max-w-[95vw] gap-0 overflow-hidden p-0">
        {/* 与 SettingsModal / 代理覆盖管理 同一套骨架：外层给高度上限 →
            flex 列 → 中间 min-h-0 flex-1 overflow-y-auto 才是真滚动容器 */}
        <div className="flex max-h-[80vh] min-h-0 flex-col bg-background">
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
            <DialogTitle className="text-lg font-semibold">
              {t("automation.matches_of", { name: rule?.name ?? "" })}
            </DialogTitle>
          </div>

          <div
            className="min-h-[80px] flex-1 overflow-y-auto px-6 py-4"
            data-slot="filter-matches-scroll"
          >
            {isLoading && (
              <div className="py-4 text-sm text-muted-foreground">
                {t("entry.loading")}
              </div>
            )}
            {isError && (
              <div className="py-4 text-sm text-destructive">
                {t("automation.load_failed")}
              </div>
            )}
            {!isLoading && !isError && matches.length === 0 && (
              <div className="py-4 text-sm text-muted-foreground">
                {t("automation.matches_empty")}
              </div>
            )}
            {matches.length > 0 && (
              <ul className="divide-y divide-border/60">
                {matches.map((match) => (
                  <li key={match.id} className="py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {match.entryTitle ||
                          t("automation.matches_deleted_entry")}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {describeActions(match.actions, t)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {match.feedTitle && (
                        <span className="min-w-0 truncate">
                          {match.feedTitle}
                        </span>
                      )}
                      <span className="text-border">·</span>
                      <span className="shrink-0 tabular-nums">
                        {formatTime(match.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 justify-end border-t border-border px-6 py-3">
            <Button size="sm" variant="ghost" onPress={onClose}>
              {t("entry.close")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
