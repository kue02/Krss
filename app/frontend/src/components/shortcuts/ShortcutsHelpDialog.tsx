import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

interface ShortcutRow {
  keys: string[];
  labelKey: string;
}

const ARTICLE_SHORTCUTS: ShortcutRow[] = [
  { keys: ["J"], labelKey: "shortcuts.next" },
  { keys: ["K"], labelKey: "shortcuts.previous" },
  { keys: ["M"], labelKey: "shortcuts.toggleRead" },
  { keys: ["S"], labelKey: "shortcuts.toggleStar" },
  { keys: ["G"], labelKey: "shortcuts.toggleReadable" },
  { keys: ["V"], labelKey: "shortcuts.openOriginal" },
  { keys: ["Esc"], labelKey: "shortcuts.close" },
];

const SIDEBAR_SHORTCUTS: ShortcutRow[] = [
  { keys: ["N"], labelKey: "shortcuts.nextFeed" },
  { keys: ["P"], labelKey: "shortcuts.prevFeed" },
  { keys: ["X"], labelKey: "shortcuts.toggleFolder" },
  { keys: ["Shift", "N"], labelKey: "shortcuts.addFeed" },
];

const GLOBAL_SHORTCUTS: ShortcutRow[] = [
  { keys: ["R"], labelKey: "shortcuts.refresh" },
  { keys: ["?"], labelKey: "shortcuts.help" },
];

function ShortcutList({ rows }: { rows: ShortcutRow[] }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div
          key={row.labelKey}
          className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-item-hover"
        >
          <span className="text-muted-foreground">{t(row.labelKey)}</span>
          <span className="flex shrink-0 items-center gap-1">
            {row.keys.map((key) => (
              <kbd
                key={key}
                className="min-w-[1.75rem] rounded-md border border-border/70 bg-muted/70 px-2 py-1 text-center text-[11px] font-semibold text-foreground shadow-[0_1px_0_rgba(0,0,0,0.04)]"
              >
                {key}
              </kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

interface ShortcutsHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 快捷键帮助 —— 按 ? 唤起（对齐 Nextflux 的 Shortcuts 弹窗） */
export function ShortcutsHelpDialog({
  open,
  onOpenChange,
}: ShortcutsHelpDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 rounded-2xl border-border/50 bg-overlay/95 p-0 shadow-nf-md backdrop-blur-xl outline-none focus:outline-none">
        <div className="border-b border-border/50 px-5 py-4">
          <DialogTitle className="text-base font-bold">
            {t("shortcuts.title")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            {t("shortcuts.description")}
          </DialogDescription>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-3 py-3">
          <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("shortcuts.article")}
          </p>
          <ShortcutList rows={ARTICLE_SHORTCUTS} />

          <p className="px-2 pb-2 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("shortcuts.sidebar")}
          </p>
          <ShortcutList rows={SIDEBAR_SHORTCUTS} />

          <p className="px-2 pb-2 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("shortcuts.global")}
          </p>
          <ShortcutList rows={GLOBAL_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
