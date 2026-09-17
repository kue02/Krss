import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  AddIcon,
  BoltIcon,
  FolderIcon,
  RssIcon,
} from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFilterEditorStore } from "@/stores/filter-editor-store";

// NextFlux 的 Button size="sm" variant="ghost" isIconOnly：实测 32×32 全圆，图标 16px，按压 0.97
const actionButtonStyles = cn(
  "dropdown-trigger inline-flex items-center justify-center",
  "rounded-full size-8",
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
  // 「新建自动化」= 直接开规则编辑器抽屉（空规则），不用先跑去设置页
  const openNewAutomation = () => useFilterEditorStore.getState().openNew();

  return (
    <div className="flex items-center justify-between gap-2 p-2">
      {/* Logo and title（对齐 Nextflux 的 sidebar-header：p-2 / gap-2 / 32px logo / 14px 名称） */}
      <div className="flex items-center gap-2 text-sm font-semibold leading-tight">
        <KrssLogo className="size-8 rounded-lg" />
        <span className="tracking-tight">{title}</span>
      </div>

      {/* Action buttons */}
      <div className="relative flex items-center gap-1">
        {/* 加号：下拉里放「添加订阅源 / 新建自动化 / 新增分类」（导入 OPML 已移除：
            低频操作，改去 设置 → 数据控制；2026-09-17 用户要求） */}
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
              onSelect={openNewAutomation}
            >
              <BoltIcon className="size-4 shrink-0 text-muted-foreground" />
              <span>{t("sidebar.new_automation")}</span>
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
