import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AddIcon, FolderIcon } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const actionButtonStyles = cn(
  "inline-flex items-center justify-center",
  "rounded-full size-8",
  "hover:bg-item-hover transition-colors duration-200",
  "data-[state=open]:bg-item-hover",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** 菜单行样式与账户菜单保持一致（对齐 Nextflux 的菜单行：28px 高 / 圆角 5px / 14px 字） */
const menuItemStyles = cn(
  "group relative flex cursor-pointer select-none items-center gap-2",
  "rounded-[5px] px-2.5 py-1 text-sm font-medium",
  "text-foreground/90 outline-none transition-colors duration-200",
  "focus:bg-accent/30 data-[highlighted]:bg-accent/20",
  "h-[28px]",
);

interface SidebarHeaderProps {
  title?: string;
  onAddClick?: () => void;
  /** 「新增分类」——不传就不显示这一项 */
  onCreateFolder?: () => void;
}

function KrssLogo({ className }: { className?: string }) {
  return (
    <img src="/logo.svg" alt="Krss" className={cn(className, "rounded")} />
  );
}

export function SidebarHeader({
  title = "Krss",
  onAddClick,
  onCreateFolder,
}: SidebarHeaderProps) {
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
        {/* 加号：下拉里放「添加订阅源 / 新增分类」（对齐 Nextflux 的加号菜单） */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={actionButtonStyles}
              aria-label={t("actions.add_feed")}
            >
              <AddIcon className="size-5 text-muted-foreground transition-transform duration-200 data-[state=open]:rotate-45" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="min-w-[180px] p-1 backdrop-blur-2xl"
          >
            <DropdownMenuItem className={menuItemStyles} onSelect={onAddClick}>
              <AddIcon className="size-4 text-muted-foreground" />
              <span>{t("actions.add_feed")}</span>
            </DropdownMenuItem>
            {onCreateFolder && (
              <DropdownMenuItem
                className={menuItemStyles}
                onSelect={onCreateFolder}
              >
                <FolderIcon className="size-4 text-muted-foreground" />
                <span>{t("folder.create")}</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
