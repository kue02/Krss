import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AddIcon } from "@/components/ui/icons";

const actionButtonStyles = cn(
  "inline-flex items-center justify-center",
  "rounded-full size-8",
  "hover:bg-item-hover transition-colors duration-200",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

interface SidebarHeaderProps {
  title?: string;
  onAddClick?: () => void;
}

function KrssLogo({ className }: { className?: string }) {
  return (
    <img src="/logo.svg" alt="Krss" className={cn(className, "rounded")} />
  );
}

export function SidebarHeader({ title = "Krss", onAddClick }: SidebarHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-2 p-2">
      {/* Logo and title（对齐 Nextflux 的 sidebar-header：p-2 / gap-2 / 32px logo / 14px 名称） */}
      <div className="flex items-center gap-2 text-sm font-semibold leading-tight">
        <KrssLogo className="size-8 rounded-lg" />
        <span className="tracking-tight">{title}</span>
      </div>

      {/* Action buttons */}
      <div className="relative flex items-center gap-1">
        {/* Add/Discover button */}
        <button
          type="button"
          className={actionButtonStyles}
          onClick={onAddClick}
          aria-label={t("actions.add_feed")}
        >
          <AddIcon className="size-5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
