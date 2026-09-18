import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateFolder } from "@/hooks/useFolders";
import { cn } from "@/lib/utils";
import type { Folder } from "@/types/api";

interface RenameFolderDialogProps {
  folder: Folder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 文件夹重命名（右键菜单调用） */
export function RenameFolderDialog({
  folder,
  open,
  onOpenChange,
}: RenameFolderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const updateFolder = useUpdateFolder();
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !updateFolder.isPending;

  useEffect(() => {
    if (!folder) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(folder.name);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [folder]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folder || !canSubmit) return;

    try {
      await updateFolder.mutateAsync({ id: folder.id, name: trimmed });
      onOpenChange(false);
    } catch {
      setError(t("folder.rename_failed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="p-4">
          <DialogTitle>{t("folder.rename")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 px-4 pb-4">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            className="w-full rounded-field border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent"
            placeholder={t("folder.name_placeholder")}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                "rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-foreground transition-opacity duration-200",
                !canSubmit && "opacity-60",
              )}
            >
              {t("actions.save")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
