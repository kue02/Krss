import { AlertDialog, Button } from "@heroui/react";
import { useTranslation } from "react-i18next";

/**
 * 12-7：设置页有未保存改动时，切页 / 关设置之前问一句。
 * 形态与 11-9（规则编辑器）保持一致的三选一：保存并离开 / 放弃更改 / 继续编辑。
 */
interface UnsavedSettingsDialogProps {
  open: boolean;
  /** 有未保存改动的页名（多于一个就拼接） */
  labels: string[];
  /** 「保存并离开」是否可用（有任意一页提供了 save） */
  canSave: boolean;
  busy?: boolean;
  onSaveAndLeave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}

export function UnsavedSettingsDialog({
  open,
  labels,
  canSave,
  busy = false,
  onSaveAndLeave,
  onDiscard,
  onStay,
}: UnsavedSettingsDialogProps) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <AlertDialog isOpen={open} onOpenChange={(next) => !next && onStay()}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="max-w-md">
            <AlertDialog.Header>
              <AlertDialog.Heading>
                {t("settings.unsaved_title")}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted-foreground">
                {t("settings.unsaved_body", { pages: labels.join(" · ") })}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="ghost"
                isDisabled={busy}
                onPress={onStay}
              >
                {t("settings.unsaved_stay")}
              </Button>
              <Button variant="ghost" isDisabled={busy} onPress={onDiscard}>
                {t("settings.unsaved_discard")}
              </Button>
              <Button
                isDisabled={busy || !canSave}
                onPress={onSaveAndLeave}
              >
                {t("settings.unsaved_save_leave")}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
