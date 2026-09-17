import { useTranslation } from "react-i18next";
import { Button, Modal } from "@heroui/react";
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
 * 2026-09-17：弹窗换 HeroUI `Modal`（原来走项目自绘的 Radix Dialog，会在控制台报
 * 「Missing Description or aria-describedby for DialogContent」）；同时把三列表格改成
 * 「时间 + 标题/来源 + 动作」的两行式列表 —— 在弹窗这种窄容器里，表格列宽一挤就没法读。
 */
export function FilterMatchesDialog({
  rule,
  onClose,
}: FilterMatchesDialogProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useFilterMatches(rule?.id ?? null, 100);
  const matches = data ?? [];

  return (
    <Modal>
      <Button className="hidden" aria-hidden />
      <Modal.Backdrop
        isOpen={Boolean(rule)}
        onOpenChange={(open) => !open && onClose()}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            <Modal.Header>
              <Modal.Heading>
                {t("automation.matches_of", { name: rule?.name ?? "" })}
              </Modal.Heading>
            </Modal.Header>

            <Modal.Body className="max-h-[60vh] min-h-[80px] overflow-y-auto">
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
            </Modal.Body>

            <Modal.Footer>
              <Button size="sm" variant="ghost" onPress={onClose}>
                {t("entry.close")}
              </Button>
            </Modal.Footer>
            <Modal.CloseTrigger />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
