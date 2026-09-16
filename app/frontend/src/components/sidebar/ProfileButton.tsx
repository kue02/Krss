import * as React from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RootPortal } from "@/components/ui/portal";
import { shortcutsHelp } from "@/stores/shortcuts-store";
import useMeasure from "react-use-measure";

// 菜单行的度量统一由 DropdownMenuItem 提供（HeroUI v3 的 .menu-item），这里只压一点前景色
const menuItemStyles = cn("text-foreground/90");

interface ProfileButtonProps {
  avatarUrl?: string;
  userName?: string;
  starredCount?: number;
  isStarredSelected?: boolean;
  onStarredClick?: () => void;
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
    {avatarUrl ? (
      <AvatarFace avatarUrl={avatarUrl} name={name} />
    ) : (
      <AvatarFace name={name} />
    )}
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

const TransitionAvatar = React.forwardRef<
  HTMLButtonElement,
  {
    stage: "zoom-in" | "";
    avatarUrl?: string;
    name?: string;
  } & React.HTMLAttributes<HTMLButtonElement>
>(({ stage, avatarUrl, name, className, children, ...props }, forwardRef) => {
  const [measureRef, { x, y }, forceRefresh] = useMeasure();
  const zoomIn = stage === "zoom-in";

  return (
    <>
      <button
        {...props}
        ref={forwardRef}
        className={cn(
          // 键盘 Tab 时给出可见焦点环（与其它按钮一致），只有鼠标操作时不打扰
          "group relative inline-flex items-center justify-center rounded-md size-8 select-none outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className,
        )}
        onPointerDown={React.useCallback(
          (e: React.PointerEvent<HTMLButtonElement>) => {
            forceRefresh();
            props.onPointerDown?.(e);
          },
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [forceRefresh, props.onPointerDown],
        )}
        onClick={React.useCallback(
          (e: React.MouseEvent<HTMLButtonElement>) => {
            forceRefresh();
            props.onClick?.(e);
          },
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [forceRefresh, props.onClick],
        )}
      >
        <UserAvatar
          ref={measureRef}
          className="size-6 border-0"
          avatarUrl={avatarUrl}
          name={name}
        />
        {children}
      </button>

      <RootPortal>
        <AnimatePresence>
          {zoomIn && x !== 0 && y !== 0 && (
            <motion.div
              initial={{
                left: x,
                top: y,
                width: 24,
                height: 24,
                opacity: 0.5,
              }}
              animate={{
                left: x - 16,
                top: y,
                width: 56,
                height: 56,
                opacity: 1,
              }}
              exit={{
                left: x,
                top: y,
                width: 24,
                height: 24,
                opacity: 0,
              }}
              transition={{
                duration: 0.2,
                ease: [0.4, 0, 0.2, 1], // Standard Ease
              }}
              className="fixed p-0 border-0 pointer-events-none rounded-full overflow-hidden bg-muted z-[100] transform-gpu shadow-xl select-none"
            >
              <AvatarFace
                avatarUrl={avatarUrl}
                name={name}
                letterClassName="text-[22px]"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </RootPortal>
    </>
  );
});
TransitionAvatar.displayName = "TransitionAvatar";

export function ProfileButton({
  avatarUrl,
  userName,
  starredCount = 0,
  isStarredSelected = false,
  onStarredClick,
  onProfileClick,
  onSettingsClick,
  onLogoutClick,
  triggerClassName,
  children,
}: ProfileButtonProps) {
  const { t } = useTranslation();
  const displayName = userName || t("user.guest");
  const [isOpen, setIsOpen] = React.useState(false);
  const iconStyles =
    "size-4 text-muted-foreground transition-colors group-data-[highlighted]:text-foreground";

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <TransitionAvatar
          stage={isOpen ? "zoom-in" : ""}
          avatarUrl={avatarUrl}
          name={userName}
          className={triggerClassName}
        >
          {children}
        </TransitionAvatar>
      </DropdownMenuTrigger>

      {/* 外观完全交给 .dropdown-content/.dropdown-surface（HeroUI v3 的度量 + NextFlux 的浮层参数） */}
      <DropdownMenuContent side="top" align="start" sideOffset={4}>

        {/* User info */}
        <DropdownMenuLabel className="px-2 pb-3 pt-6 relative z-10 text-center">
          <div className="flex flex-col items-center justify-center">
            <div className="max-w-[20ch] truncate text-lg font-semibold tracking-tight text-foreground">
              {displayName}
            </div>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator className="bg-border/50" />

        {/* Profile */}
        <DropdownMenuItem className={menuItemStyles} onSelect={onProfileClick}>
          <span className="inline-flex size-4 items-center justify-center">
            <svg
              className={iconStyles}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
              />
            </svg>
          </span>
          <span>{t("user.profile")}</span>
        </DropdownMenuItem>

        {/* Starred */}
        <DropdownMenuItem
          className={cn(menuItemStyles, isStarredSelected && "bg-accent/30")}
          onSelect={onStarredClick}
        >
          <span className="inline-flex size-4 items-center justify-center">
            <svg
              className={iconStyles}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
              />
            </svg>
          </span>
          <span>{t("sidebar.starred")}</span>
          {starredCount > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">
              {starredCount}
            </span>
          )}
        </DropdownMenuItem>

        <DropdownMenuSeparator className="bg-border/50" />

        {/* Settings */}
        <DropdownMenuItem className={menuItemStyles} onSelect={onSettingsClick}>
          <span className="inline-flex size-4 items-center justify-center">
            <svg
              className={iconStyles}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </span>
          <span>{t("settings.title")}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="bg-border/50" />

        {/* Shortcuts help —— 与 ? 键同一入口 */}
        <DropdownMenuItem
          className={menuItemStyles}
          onSelect={() => shortcutsHelp.toggle()}
        >
          <span className="inline-flex size-4 items-center justify-center">
            <svg
              className={iconStyles}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 7.5h16v9H4z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7.5 10.5h.01M10.5 10.5h.01M13.5 10.5h.01M16.5 10.5h.01M9 13.5h6"
              />
            </svg>
          </span>
          <span>{t("shortcuts.title")}</span>
          <span className="ml-auto text-xs text-muted-foreground">?</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="bg-border/50" />

        {/* Logout */}
        <DropdownMenuItem
          className={cn(menuItemStyles, "text-danger")}
          onSelect={onLogoutClick}
        >
          <span className="inline-flex size-4 items-center justify-center">
            <svg
              className={iconStyles}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </span>
          <span>{t("user.logout")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
