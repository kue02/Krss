import { useTranslation } from "react-i18next";
import { BellOff, ChevronsUp, ShieldOff, Star, Wand2 } from "lucide-react";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { useUnmuteEntry, useCreateFilterException } from "@/hooks/useFilters";
import { readToggleAction } from "@/components/entry-list/read-toggle-action";
import { showToast } from "@/stores/toast-store";
import { openFilterEditorForEntry } from "@/stores/filter-editor-store";
import type { Entry } from "@/types/api";
import { MobileActionSheet, MobileActionSheetItem } from "./MobileActionSheet";

interface MobileEntryActionsProps {
  entry: Entry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkAbove?: (entryId: string) => void;
}

/** 移动端长按条目后的操作面板：与桌面右键菜单同语义，只保留手机高频动作。 */
export function MobileEntryActions({
  entry,
  open,
  onOpenChange,
  onMarkAbove,
}: MobileEntryActionsProps) {
  const { t } = useTranslation();
  const unmute = useUnmuteEntry();
  const exception = useCreateFilterException();
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();
  const readAction = entry ? readToggleAction(!entry.read) : null;

  if (!entry || !readAction) return null;

  return (
    <MobileActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={entry.title || t("entry.untitled")}
    >
      <MobileActionSheetItem
        icon={<readAction.Icon className="size-5" />}
        label={t(readAction.labelKey)}
        selected={!entry.read}
        onClick={() => {
          onOpenChange(false);
          markAsRead({ id: entry.id, read: readAction.nextRead });
        }}
      />
      <MobileActionSheetItem
        icon={
          <Star className="size-5" fill={entry.starred ? "currentColor" : "none"} />
        }
        label={
          entry.starred
            ? t("entry.remove_from_starred")
            : t("entry.add_to_starred")
        }
        selected={entry.starred}
        onClick={() => {
          onOpenChange(false);
          markAsStarred({ id: entry.id, starred: !entry.starred });
        }}
      />
      {onMarkAbove && (
        <MobileActionSheetItem
          icon={<ChevronsUp className="size-5" />}
          label={t("entry.mark_above_read")}
          onClick={() => {
            onOpenChange(false);
            onMarkAbove(entry.id);
          }}
        />
      )}
      {entry.muted && (
        <MobileActionSheetItem
          icon={<BellOff className="size-5" />}
          label={t("automation.unmute_entry")}
          onClick={() => {
            onOpenChange(false);
            unmute.mutate(entry.id, {
              onSuccess: () => showToast(t("automation.unmuted")),
            });
          }}
        />
      )}
      <MobileActionSheetItem
        icon={<ShieldOff className="size-5" />}
        label={t("automation.exception_entry")}
        disabled={exception.isPending}
        onClick={() => {
          onOpenChange(false);
          exception.mutate(entry.id, {
            onSuccess: (rule) =>
              showToast(t("automation.exception_created", { name: rule.name })),
            onError: () => showToast(t("automation.exception_failed")),
          });
        }}
      />
      <MobileActionSheetItem
        icon={<Wand2 className="size-5" />}
        label={t("automation.rule_from_entry")}
        onClick={() => {
          onOpenChange(false);
          openFilterEditorForEntry(entry);
        }}
      />
    </MobileActionSheet>
  );
}
