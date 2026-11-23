import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ProfileButton } from "./ProfileButton";

interface SidebarAccountBarProps {
  avatarUrl?: string;
  userName?: string;
  onProfileClick?: () => void;
  onSettingsClick?: () => void;
  onShortcutsClick?: () => void;
  onLogoutClick?: () => void;
  /** 移动端：与上方滚动区用发丝线分隔，并让出底部安全区（Home 指示条） */
  mobile?: boolean;
}

/**
 * 侧栏底部账户栏 —— Nextflux 的尾巴
 *
 * 头像（点击展开账户菜单：个人资料 / 已加星标 / 设置 / 退出登录）+ 用户名。
 * 原先头像挤在顶部品牌区，挪到底部后顶部只留「logo + 添加订阅」，与 Nextflux 的分工一致。
 */
export function SidebarAccountBar({
  avatarUrl,
  userName,
  onProfileClick,
  onSettingsClick,
  onShortcutsClick,
  onLogoutClick,
  mobile = false,
}: SidebarAccountBarProps) {
  const { t } = useTranslation();
  const displayName = userName || t("user.guest");

  return (
    <div
      className={cn(
        "mx-2 mt-1 shrink-0",
        mobile &&
          "mt-0 border-t border-border/60 px-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))] pt-1.5",
      )}
    >
      <ProfileButton
        avatarUrl={avatarUrl}
        userName={displayName}
        onProfileClick={onProfileClick}
        onSettingsClick={onSettingsClick}
        onShortcutsClick={onShortcutsClick}
        onLogoutClick={onLogoutClick}
        // 整行可点（头像 + 名字），和 Nextflux 一致；不是只有那个 32px 的头像能点
        triggerClassName="dropdown-trigger flex h-10 w-full items-center gap-2 rounded-[19.2px] px-3 py-2 text-left hover:bg-item-hover data-[state=open]:bg-item-hover"
      >
        {/* 与 NextFlux 的 ProfileButton 同构：头像 + 名字（truncate）；右侧上下箭头由 ProfileButton 自己渲染，
            这里不要再画一个 —— 否则触发按钮里会出现两个一模一样的 chevrons-up-down（2026-09-17 用户报） */}
        <span className="min-w-0 flex-1 select-none truncate text-sm font-medium leading-tight text-foreground/90">
          {displayName}
        </span>
      </ProfileButton>
    </div>
  );
}
