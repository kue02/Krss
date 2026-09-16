import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  AddIcon,
  FolderIcon,
  RssIcon,
  UploadIcon,
} from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { startImportOPML } from "@/api";
import { showToast } from "@/stores/toast-store";

// HeroUI v3 的 Button size="sm" variant="ghost" isIconOnly：36px 圆形按钮，按压 0.97
const actionButtonStyles = cn(
  "dropdown-trigger inline-flex items-center justify-center",
  "rounded-full size-9",
  "transition-colors duration-150",
  "hover:bg-item-hover data-[state=open]:bg-item-hover",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** 菜单行度量统一由 DropdownMenuItem（HeroUI .menu-item）提供，这里只压前景色 */
const menuItemStyles = cn("text-foreground/90");

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
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 与 NextFlux 的 AddFeedButton 一致：加号菜单里直接导入 OPML
  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await startImportOPML(file);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["feeds"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
      ]);
      showToast(t("sidebar.import_success"));
    } catch (error) {
      showToast(
        error instanceof Error
          ? `${t("sidebar.import_failed")}: ${error.message}`
          : t("sidebar.import_failed"),
      );
    } finally {
      event.target.value = "";
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 p-2">
      {/* Logo and title（对齐 Nextflux 的 sidebar-header：p-2 / gap-2 / 32px logo / 14px 名称） */}
      <div className="flex items-center gap-2 text-sm font-semibold leading-tight">
        <KrssLogo className="size-8 rounded-lg" />
        <span className="tracking-tight">{title}</span>
      </div>

      {/* Action buttons */}
      <div className="relative flex items-center gap-1">
        <input
          ref={fileInputRef}
          type="file"
          accept=".opml,.xml"
          onChange={handleFileChange}
          className="hidden"
        />

        {/* 加号：下拉里放「添加订阅源 / 导入 OPML / 新增分类」，与 NextFlux 的加号菜单同构 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={actionButtonStyles}
              aria-label={t("actions.add_feed")}
            >
              <AddIcon className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            <DropdownMenuItem className={menuItemStyles} onSelect={onAddClick}>
              <RssIcon className="size-4 shrink-0 text-muted-foreground" />
              <span>{t("actions.add_feed")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={menuItemStyles}
              onSelect={() => fileInputRef.current?.click()}
            >
              <UploadIcon className="size-4 shrink-0 text-muted-foreground" />
              <span>{t("sidebar.import_opml")}</span>
            </DropdownMenuItem>
            {onCreateFolder && (
              <DropdownMenuItem
                className={menuItemStyles}
                onSelect={onCreateFolder}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span>{t("folder.create")}</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
