import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button, Dropdown, Label, Kbd } from "@heroui/react";
import { ChevronsUpDown, CircleUser, Cog, Keyboard, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortcutsHelp } from "@/stores/shortcuts-store";

interface ProfileButtonProps {
  avatarUrl?: string;
  userName?: string;
  onProfileClick?: () => void;
  onSettingsClick?: () => void;
  onLogoutClick?: () => void;
  /** 触发器的额外类名（侧栏账户栏把整行做成触发器时用） */
  triggerClassName?: string;
  /** 触发器里头像后面的内容（一般放用户名） */
  children?: React.ReactNode;
}

const UserAvatar = React.forwardRef<
  HTMLSpanElement,
  {
    className?: string;
    avatarUrl?: string;
    name?: string;
    style?: React.CSSProperties;
    onTransitionEnd?: () => void;
    hideName?: boolean;
  }
>(({ className, avatarUrl, name, style, onTransitionEnd }, ref) => (
  <span
    ref={ref}
    style={style}
    onTransitionEnd={onTransitionEnd}
    className={cn(
      "relative flex shrink-0 overflow-hidden rounded-full border bg-muted select-none",
      className,
    )}
  >
    <AvatarFace avatarUrl={avatarUrl} name={name} />
  </span>
));

UserAvatar.displayName = "UserAvatar";

/**
 * 头像本体：有图就用图，图挂了 / 没有就退成「首字母」头像。
 * Gravatar 在没设头像时会给一张默认的灰色小人，所以后端改用 d=404，
 * 加载失败落到这里 —— 首字母头像比灰色小人像回事（也和 logo 的 K 呼应）。
 */
function AvatarFace({
  avatarUrl,
  name,
  letterClassName = "text-[11px]",
}: {
  avatarUrl?: string;
  name?: string;
  letterClassName?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const letter = (name?.trim()?.[0] ?? "?").toUpperCase();

  if (avatarUrl && !failed) {
    return (
      <img
        className="size-full object-cover"
        src={avatarUrl}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-accent/15 font-semibold leading-none text-accent",
        letterClassName,
      )}
    >
      {letter}
    </span>
  );
}

export { UserAvatar };

/**
 * 账户菜单（侧栏底部那一行）。
 *
 * 2026-09-17 重做：**改用 HeroUI v3 的 Dropdown**，结构与 Nextflux 的
 * `FeedList/components/ProfileButton.jsx` 同构（Dropdown → Popover placement="top left" →
 * Menu onAction → Item id/textValue + lucide 图标 + Label），不再自绘菜单壳。
 * 同时按用户要求**去掉「已加星标」**——星标有侧栏/Debug 之外的入口，不该占账户菜单。
 */
export function ProfileButton({
  avatarUrl,
  userName,
  onProfileClick,
  onSettingsClick,
  onLogoutClick,
  triggerClassName,
  children,
}: ProfileButtonProps) {
  const { t } = useTranslation();
  const displayName = userName || t("user.guest");
  const iconStyles = "size-4 text-muted-foreground group-data-[highlighted]:text-foreground";

  const handleAction = (key: React.Key) => {
    if (key === "profile") onProfileClick?.();
    if (key === "settings") onSettingsClick?.();
    if (key === "shortcuts") shortcutsHelp.toggle();
    if (key === "logout") onLogoutClick?.();
  };

  return (
    <Dropdown>
      <Dropdown.Trigger
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-[19.2px] px-3 py-2 text-left",
          triggerClassName,
        )}
      >
        <UserAvatar className="size-6 border-0" avatarUrl={avatarUrl} name={userName} />
        {children ?? (
          <span className="min-w-0 flex-1 select-none truncate text-sm font-medium leading-tight text-foreground/90">
            {displayName}
          </span>
        )}
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </Dropdown.Trigger>

      <Dropdown.Popover placement="top left" className="min-w-[13rem]">
        <Dropdown.Menu aria-label={displayName} onAction={handleAction}>
          <Dropdown.Item id="profile" textValue={t("user.profile")}>
            <CircleUser className={iconStyles} />
            <Label>{t("user.profile")}</Label>
          </Dropdown.Item>

          <Dropdown.Item id="settings" textValue={t("settings.title")}>
            <Cog className={iconStyles} />
            <Label>{t("settings.title")}</Label>
          </Dropdown.Item>

          {/* Shortcuts help —— 与 ? 键同一入口 */}
          <Dropdown.Item id="shortcuts" textValue={t("shortcuts.title")}>
            <Keyboard className={iconStyles} />
            <Label>{t("shortcuts.title")}</Label>
            <Kbd className="ml-auto">?</Kbd>
          </Dropdown.Item>

          <Dropdown.Item id="logout" textValue={t("user.logout")} variant="danger">
            <LogOut className="size-4" />
            <Label>{t("user.logout")}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 触发器按钮（其它地方要用同一颗按钮时用） */
export function ProfileTriggerButton(props: React.ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="sm" {...props} />;
}
