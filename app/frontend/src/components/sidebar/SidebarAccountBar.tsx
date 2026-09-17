import { useTranslation } from "react-i18next";
import { ChevronsUpDownIcon } from "@/components/ui/icons";
import { ProfileButton } from "./ProfileButton";

interface SidebarAccountBarProps {
  avatarUrl?: string;
  userName?: string;
  onProfileClick?: () => void;
  onSettingsClick?: () => void;
  onLogoutClick?: () => void;
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
  onLogoutClick,
}: SidebarAccountBarProps) {
  const { t } = useTranslation();
  const displayName = userName || t("user.guest");

  return (
    <div className="mx-2 mt-1 shrink-0">
      <ProfileButton
        avatarUrl={avatarUrl}
        userName={displayName}
        onProfileClick={onProfileClick}
        onSettingsClick={onSettingsClick}
        onLogoutClick={onLogoutClick}
        // 整行可点（头像 + 名字），和 Nextflux 一致；不是只有那个 32px 的头像能点
        triggerClassName="dropdown-trigger flex h-10 w-full items-center gap-2 rounded-[19.2px] px-3 py-2 text-left hover:bg-item-hover data-[state=open]:bg-item-hover"
      >
        {/* 与 NextFlux 的 ProfileButton 同构：图标 + 名字（font-semibold, truncate）+ 右侧上下箭头 */}
        <span className="min-w-0 flex-1 select-none truncate text-sm font-medium leading-tight text-foreground/90">
          {displayName}
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </ProfileButton>
    </div>
  );
}
