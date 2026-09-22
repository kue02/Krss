import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog, Button } from "@heroui/react";
import { CheckCircle2, Copy, TriangleAlert } from "lucide-react";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { copyToClipboard } from "@/stores/toast-store";
import { useRefreshReportStore } from "@/stores/refresh-report-store";

/**
 * 刷新结果弹框（用户 11-8）。
 *
 * 口径按用户原话：
 *   - 告知一共更新了多少条；**点「查看详情」放明细**（哪个订阅新增/更新了多少条、带图标），
 *     点了就**手动关闭**；**没点则 3 秒自动关**；
 *   - 失败要给原因、**能复制**，而且**必须手动关闭**（不让错误一闪而过）。
 */
const AUTO_CLOSE_MS = 3000;

export function RefreshReportDialog() {
  const { t } = useTranslation();
  const report = useRefreshReportStore((state) => state.report);
  const detailsOpen = useRefreshReportStore((state) => state.detailsOpen);
  const close = useRefreshReportStore((state) => state.close);
  const toggleDetails = useRefreshReportStore((state) => state.toggleDetails);

  const failed = (report?.failures.length ?? 0) > 0;

  useEffect(() => {
    // 失败、或用户已经展开详情 → 不自动关（用户要能看完 / 复制）
    if (!report || failed || detailsOpen) return;
    const timer = setTimeout(close, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [report, failed, detailsOpen, close]);

  if (!report) return null;

  return (
    <AlertDialog>
      <Button className="hidden" aria-hidden />
      <AlertDialog.Backdrop
        isOpen={report !== null}
        onOpenChange={(open) => !open && close()}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="max-w-md">
            <AlertDialog.Header>
              <AlertDialog.Icon>
                {failed ? <TriangleAlert /> : <CheckCircle2 />}
              </AlertDialog.Icon>
              <AlertDialog.Heading>
                {failed
                  ? t("refresh_report.title_failed")
                  : t("refresh_report.title_done")}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="text-sm">
                {t("refresh_report.summary", {
                  changed: report.changed,
                  created: report.created,
                  updated: report.updated,
                })}
              </div>
              {failed && (
                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {report.failures.map((item) => (
                    <div key={item.feedId} className="text-xs text-destructive">
                      {item.title}：{item.error}
                    </div>
                  ))}
                </div>
              )}
              {detailsOpen && (
                <div className="mt-3 max-h-64 space-y-1 overflow-y-auto border-t border-border/60 pt-3">
                  {report.results.map((item) => (
                    <div key={item.feedId} className="flex items-center gap-2 text-xs">
                      <FeedAvatar iconPath={item.iconPath} size={16} rounded="circle" />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.error ? (
                        <span className="shrink-0 text-destructive">
                          {t("refresh_report.item_failed")}
                        </span>
                      ) : item.skipped ? (
                        <span className="shrink-0 text-muted-foreground">
                          {t("refresh_report.item_skipped")}
                        </span>
                      ) : (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t("refresh_report.item_counts", {
                            created: item.new,
                            updated: item.updated,
                          })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              {!detailsOpen && report.results.length > 1 && (
                <Button size="sm" variant="ghost" onPress={toggleDetails}>
                  {t("refresh_report.view_details")}
                </Button>
              )}
              {failed && (
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    const text = report.failures
                      .map((item) => `${item.title}: ${item.error}`)
                      .join("\n");
                    void copyToClipboard(text, t("refresh_report.copied"));
                  }}
                >
                  <Copy className="size-3.5" />
                  {t("refresh_report.copy_reason")}
                </Button>
              )}
              <Button size="sm" onPress={close}>
                {t("refresh_report.close")}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
