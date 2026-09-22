import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateFeedsOverrides } from "@/hooks/useFeeds";
import { cn } from "@/lib/utils";

interface FolderOverridesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderName?: string;
  /** 这个分类下的订阅 id */
  feedIds: string[];
}

/** 三档：跟随全局 / 开 / 关（正文打开方式把「开」显示成「阅读模式」） */
function TriStateRow({
  label,
  value,
  onChange,
  onLabel,
  offLabel,
}: {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  onLabel: string;
  offLabel: string;
}) {
  const { t } = useTranslation();
  const options: { value: boolean | null; label: string }[] = [
    { value: null, label: t("feeds.follow_global") },
    { value: true, label: onLabel },
    { value: false, label: offLabel },
  ];

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex shrink-0 gap-1 rounded-full border border-border p-0.5">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs transition-colors duration-200",
              option.value === value
                ? "bg-item-active text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 分类批量设置：把这一分类下所有订阅的「自动翻译 / 自动摘要 / 正文打开方式」一次设好。
 * 注意会覆盖这些订阅各自的单独设置（编辑器里逐条改仍然更细）。
 */
export function FolderOverridesDialog({
  open,
  onOpenChange,
  folderName,
  feedIds,
}: FolderOverridesDialogProps) {
  const { t } = useTranslation();
  const [autoTranslate, setAutoTranslate] = useState<boolean | null>(null);
  const [autoSummary, setAutoSummary] = useState<boolean | null>(null);
  const [readerMode, setReaderMode] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateOverrides = useUpdateFeedsOverrides();

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setAutoTranslate(null);
    setAutoSummary(null);
    setReaderMode(null);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (feedIds.length === 0 || updateOverrides.isPending) return;

    try {
      await updateOverrides.mutateAsync({
        feedIds,
        autoTranslate,
        autoSummary,
        readerMode,
      });
      onOpenChange(false);
    } catch {
      setError(t("feeds.bulk_update_failed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="p-4">
          <DialogTitle>
            {t("feeds.folder_overrides_title", { name: folderName ?? "" })}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
          <p className="text-xs text-muted-foreground">
            {t("feeds.folder_overrides_hint", { count: feedIds.length })}
          </p>
          <TriStateRow
            label={t("feeds.auto_translate")}
            value={autoTranslate}
            onChange={setAutoTranslate}
            onLabel={t("feeds.on")}
            offLabel={t("feeds.off")}
          />
          <TriStateRow
            label={t("feeds.auto_summary")}
            value={autoSummary}
            onChange={setAutoSummary}
            onLabel={t("feeds.on")}
            offLabel={t("feeds.off")}
          />
          <TriStateRow
            label={t("feeds.reader_mode")}
            value={readerMode}
            onChange={setReaderMode}
            onLabel={t("feeds.reader_mode_on")}
            offLabel={t("feeds.reader_mode_off")}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-[var(--radius)] border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-secondary"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={feedIds.length === 0 || updateOverrides.isPending}
              className={cn(
                "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {updateOverrides.isPending
                ? t("settings.saving")
                : t("actions.save")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
