import { useState, useEffect, useRef, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentUser, updateProfile, setAuthToken } from "@/api";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { UserAvatar } from "@/components/sidebar/ProfileButton";

export function ProfileSettings() {
  const { t } = useTranslation();
  const { user, setUser } = useAuthStore();
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoadingNickname, setIsLoadingNickname] = useState(false);
  const [isLoadingEmail, setIsLoadingEmail] = useState(false);
  const [isLoadingPassword, setIsLoadingPassword] = useState(false);
  const [nicknameStatus, setNicknameStatus] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [emailStatus, setEmailStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const [passwordStatus, setPasswordStatus] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [avatarUrlInput, setAvatarUrlInput] = useState("");
  const [isLoadingAvatar, setIsLoadingAvatar] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setNickname(user.nickname);
      setEmail(user.email);
    } else {
      getCurrentUser()
        .then((userData) => {
          setUsername(userData.username);
          setNickname(userData.nickname);
          setEmail(userData.email);
        })
        .catch(() => {
          // ignore
        });
    }
  }, [user]);

  /**
   * 头像：本地图片先压到 128px 再转 data URL（几 KB），这样：
   * - 不用为此加一套文件上传/静态服务；
   * - 设置值本身就能直接被 <img src> 用；
   * - 服务端只存字符串，默认行为（没设过用 Gravatar）不变。
   */
  const applyAvatar = async (avatarUrl: string, errorText?: string) => {
    setIsLoadingAvatar(true);
    setAvatarStatus("idle");
    setError(null);
    try {
      const result = await updateProfile({ avatarUrl });
      setUser(result.user);
      setAvatarStatus("success");
      setTimeout(() => setAvatarStatus("idle"), 2000);
    } catch (err) {
      setAvatarStatus("error");
      setError(errorText ?? (err instanceof Error ? err.message : "Failed to update avatar"));
    } finally {
      setIsLoadingAvatar(false);
    }
  };

  const handlePickAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(t("profile.avatar_invalid"));
      return;
    }
    try {
      const dataUrl = await downscaleImage(file, 128);
      await applyAvatar(dataUrl);
    } catch {
      setError(t("profile.avatar_invalid"));
    }
  };

  const handleSaveNickname = async () => {
    setIsLoadingNickname(true);
    setNicknameStatus("idle");
    setError(null);
    try {
      const result = await updateProfile({ nickname });
      setUser(result.user);
      setNicknameStatus("success");
      setTimeout(() => setNicknameStatus("idle"), 2000);
    } catch (err) {
      setNicknameStatus("error");
      setError(
        err instanceof Error ? err.message : "Failed to update nickname",
      );
    } finally {
      setIsLoadingNickname(false);
    }
  };

  const handleSaveEmail = async () => {
    setIsLoadingEmail(true);
    setEmailStatus("idle");
    setError(null);
    try {
      const result = await updateProfile({ email });
      setUser(result.user);
      setEmailStatus("success");
      setTimeout(() => setEmailStatus("idle"), 2000);
    } catch (err) {
      setEmailStatus("error");
      setError(err instanceof Error ? err.message : "Failed to update email");
    } finally {
      setIsLoadingEmail(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t("auth.password_mismatch"));
      return;
    }

    if (newPassword.length < 6) {
      setError(t("auth.password_too_short"));
      return;
    }

    setIsLoadingPassword(true);
    setPasswordStatus("idle");
    try {
      const result = await updateProfile({ currentPassword, newPassword });
      // Update token if password was changed (old tokens are invalidated)
      if (result.token) {
        setAuthToken(result.token);
      }
      setPasswordStatus("success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordStatus("idle"), 2000);
    } catch (err) {
      setPasswordStatus("error");
      setError(
        err instanceof Error ? err.message : "Failed to change password",
      );
    } finally {
      setIsLoadingPassword(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            {t("actions.close")}
          </button>
        </div>
      )}

      {/* Avatar Section */}
      <section>
        <div className="flex items-center gap-4">
          <UserAvatar
            className="size-16 shrink-0 border-0"
            avatarUrl={user?.avatarUrl}
            name={user?.nickname || user?.username || ""}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("profile.avatar")}</div>
            <div className="text-xs text-muted-foreground">
              {t("profile.avatar_hint")}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isLoadingAvatar}
                className={cn(
                  "h-8 rounded-md px-3 text-xs font-medium transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  avatarStatus === "success" && "bg-green-600 hover:bg-green-600",
                  avatarStatus === "error" && "bg-destructive hover:bg-destructive",
                )}
              >
                {isLoadingAvatar
                  ? t("profile.saving")
                  : avatarStatus === "success"
                    ? t("profile.saved")
                    : t("profile.avatar_upload")}
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void handlePickAvatarFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <input
                type="text"
                value={avatarUrlInput}
                onChange={(event) => setAvatarUrlInput(event.target.value)}
                placeholder={t("profile.avatar_url_placeholder")}
                className={cn(
                  "h-8 w-44 max-w-full rounded-md border border-border bg-background px-2 text-xs",
                  "placeholder:text-muted-foreground/50",
                  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                )}
              />
              <button
                type="button"
                onClick={() => void applyAvatar(avatarUrlInput.trim())}
                disabled={isLoadingAvatar || !avatarUrlInput.trim()}
                className={cn(
                  "h-8 rounded-md border border-border px-2.5 text-xs font-medium transition-colors",
                  "hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {t("profile.avatar_use_url")}
              </button>
              <button
                type="button"
                onClick={() => void applyAvatar("")}
                disabled={isLoadingAvatar}
                className={cn(
                  "h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors",
                  "hover:bg-secondary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {t("profile.avatar_reset")}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Username Section (Read-only) */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("profile.username")}</div>
            <div className="text-xs text-muted-foreground">
              {t("profile.username_readonly")}
            </div>
          </div>
          <input
            type="text"
            value={username}
            disabled
            className={cn(
              "h-9 w-48 max-w-full shrink-0 rounded-md border border-border bg-secondary px-3 text-sm",
              "text-muted-foreground cursor-not-allowed",
            )}
          />
        </div>
      </section>

      {/* Nickname Section */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("profile.nickname")}</div>
            <div className="text-xs text-muted-foreground">
              {t("profile.nickname_hint")}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className={cn(
                "h-9 w-48 max-w-full rounded-md border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
            />
            <button
              type="button"
              onClick={handleSaveNickname}
              disabled={isLoadingNickname || !nickname}
              className={cn(
                "h-9 rounded-md px-3 text-sm font-medium transition-colors shrink-0",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                nicknameStatus === "success" &&
                  "bg-green-600 hover:bg-green-600",
                nicknameStatus === "error" &&
                  "bg-destructive hover:bg-destructive",
              )}
            >
              {isLoadingNickname
                ? t("profile.saving")
                : nicknameStatus === "success"
                  ? t("profile.saved")
                  : t("profile.save_nickname")}
            </button>
          </div>
        </div>
      </section>

      {/* Email Section */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">{t("profile.email")}</div>
          <div className="flex shrink-0 gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(
                "h-9 w-48 max-w-full rounded-md border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
            />
            <button
              type="button"
              onClick={handleSaveEmail}
              disabled={isLoadingEmail || !email}
              className={cn(
                "h-9 rounded-md px-3 text-sm font-medium transition-colors shrink-0",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                emailStatus === "success" && "bg-green-600 hover:bg-green-600",
                emailStatus === "error" &&
                  "bg-destructive hover:bg-destructive",
              )}
            >
              {isLoadingEmail
                ? t("profile.saving")
                : emailStatus === "success"
                  ? t("profile.saved")
                  : t("profile.save_email")}
            </button>
          </div>
        </div>
      </section>

      {/* Change Password Section */}
      <section>
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("profile.change_password")}
        </div>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {t("profile.current_password")}
            </div>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={cn(
                "h-9 w-48 max-w-full shrink-0 rounded-md border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
              autoComplete="current-password"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {t("profile.new_password")}
            </div>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={cn(
                "h-9 w-48 max-w-full shrink-0 rounded-md border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {t("profile.confirm_new_password")}
            </div>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={cn(
                "h-9 w-48 max-w-full shrink-0 rounded-md border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
              autoComplete="new-password"
            />
          </div>
          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={
                isLoadingPassword ||
                !currentPassword ||
                !newPassword ||
                !confirmPassword
              }
              className={cn(
                "h-9 rounded-md px-3 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                passwordStatus === "success" &&
                  "bg-green-600 hover:bg-green-600",
                passwordStatus === "error" &&
                  "bg-destructive hover:bg-destructive",
              )}
            >
              {isLoadingPassword
                ? t("profile.saving")
                : passwordStatus === "success"
                  ? t("profile.password_changed")
                  : t("profile.save_password")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/**
 * 把用户选的图片压到 maxSize 见方、JPEG 0.85，返回 data URL。
 * 头像用不着大图：128px 的 JPEG 大约几 KB，直接存进设置也毫无压力。
 */
async function downscaleImage(file: File, maxSize: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.85);
}
