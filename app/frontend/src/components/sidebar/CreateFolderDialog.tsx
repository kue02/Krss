import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateFolder } from "@/hooks/useFolders";
import { cn } from "@/lib/utils";
import type { ContentType } from "@/types/api";

interface CreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 新分类归属的内容类型（跟着当前视图走） */
  contentType?: ContentType;
  onCreated?: (name: string) => void;
}

/** 新建分类（侧栏「+」下拉里的「新增分类」） */
export function CreateFolderDialog({
  open,
  onOpenChange,
  contentType,
  onCreated,
}: CreateFolderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createFolder = useCreateFolder();
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !createFolder.isPending;

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setName("");
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    try {
      await createFolder.mutateAsync({ name: trimmed, type: contentType });
      onCreated?.(trimmed);
      onOpenChange(false);
    } catch {
      setError(t("folder.create_failed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="p-4">
          <DialogTitle>{t("folder.create")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("folder.name_placeholder")}
            className={cn(
              "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary/50",
              "placeholder:text-muted-foreground",
            )}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {createFolder.isPending ? t("settings.saving") : t("actions.save")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
