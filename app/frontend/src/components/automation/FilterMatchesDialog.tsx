import { useTranslation } from "react-i18next";
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
 * 规则表里的命中数点开就是它：按时间倒序列出这条规则处理过的条目（条目标题 + 来源 +
 * 当时执行的动作）。条目被删掉后日志仍在，标题为空时显示占位文案。
 */
export function FilterMatchesDialog({
  rule,
  onClose,
}: FilterMatchesDialogProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useFilterMatches(rule?.id ?? null, 100);

  return (
    <Dialog open={Boolean(rule)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="text-base font-semibold">
          {t("automation.matches_of", { name: rule?.name ?? "" })}
        </DialogTitle>

        <div className="mt-3 max-h-[60vh] min-h-[80px] overflow-auto">
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
          {!isLoading && !isError && (data?.length ?? 0) === 0 && (
            <div className="py-4 text-sm text-muted-foreground">
              {t("automation.matches_empty")}
            </div>
          )}
          {(data?.length ?? 0) > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-medium text-muted-foreground">
                  <th className="border-b border-border py-1.5 text-left font-medium">
                    {t("automation.col_last_matched")}
                  </th>
                  <th className="border-b border-border py-1.5 text-left font-medium">
                    {t("automation.matches_entry")}
                  </th>
                  <th className="w-32 border-b border-border py-1.5 text-left font-medium">
                    {t("automation.col_actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.map((match) => (
                  <tr key={match.id} className="align-top">
                    <td className="whitespace-nowrap border-b border-border/60 py-1.5 pr-3 text-xs text-muted-foreground">
                      {formatTime(match.createdAt)}
                    </td>
                    <td className="border-b border-border/60 py-1.5 pr-3">
                      <span className="block truncate">
                        {match.entryTitle ||
                          t("automation.matches_deleted_entry")}
                      </span>
                      {match.feedTitle && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {match.feedTitle}
                        </span>
                      )}
                    </td>
                    <td className="border-b border-border/60 py-1.5 text-xs text-muted-foreground">
                      {describeActions(match.actions, t)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
