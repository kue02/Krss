import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, testNotify, updateGeneralSettings } from "@/api";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { queryClient } from "@/lib/queryClient";

/**
 * 推送（Bark）：自动化规则的「推送到手机」动作没单独填地址时，走这里的全局地址。
 *
 * 地址里带着设备 key（属凭证），只存在你自己的库里 —— 保存走通用设置接口，测试推送走
 * /api/notify/test，与规则命中时是同一条发送路径，所以它通了就说明地址、代理、出网都对。
 */
export function NotifySettings() {
  const { t } = useTranslation();
  const { data: generalSettings } = useGeneralSettings();
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!generalSettings) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setUrl(generalSettings.barkUrl ?? "");
  }, [generalSettings]);

  const savedUrl = generalSettings?.barkUrl ?? "";
  const isDirty = url.trim() !== savedUrl;

  const save = useCallback(
    async (nextUrl: string) => {
      if (!generalSettings) return;
      // 通用设置是整体 PUT：先展开现有值再覆盖本块字段，别把别人刚存的擦掉
      await updateGeneralSettings({ ...generalSettings, barkUrl: nextUrl });
      queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
    },
    [generalSettings],
  );

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      await save(url.trim());
      setStatus({ kind: "ok", text: t("settings.notify_saved") });
    } catch (error) {
      setStatus({
        kind: "error",
        text:
          error instanceof ApiError
            ? error.message
            : t("settings.notify_save_failed"),
      });
    } finally {
      setIsSaving(false);
    }
  }, [save, t, url]);

  const handleTest = useCallback(async () => {
    // 没填地址也不把按钮置灰 —— 点了没反应是最难查的失败；这里给一句可见原因
    if (!url.trim() && !savedUrl) {
      setStatus({ kind: "error", text: t("settings.notify_test_no_url") });
      return;
    }
    setIsTesting(true);
    setStatus(null);
    try {
      // 改了地址就先存再测，免得多点一次还不知道测的是哪份
      if (isDirty) {
        await save(url.trim());
      }
      const result = await testNotify();
      setStatus({
        kind: "ok",
        text: t("settings.notify_test_ok", { status: result.status }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setStatus({ kind: "error", text: t("settings.notify_test_no_url") });
      } else {
        setStatus({
          kind: "error",
          text:
            error instanceof ApiError
              ? t("settings.notify_test_failed", { reason: error.message })
              : t("settings.notify_test_failed", {
                  reason: (error as Error).message,
                }),
        });
      }
    } finally {
      setIsTesting(false);
    }
  }, [isDirty, save, t, url]);

  return (
    <section className="space-y-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("settings.notify_label")}</div>
        <div className="text-xs text-muted-foreground">
          {t("settings.notify_description")}
        </div>
      </div>

      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://api.day.app/your-key"
        className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-foreground transition-opacity duration-200 disabled:opacity-50"
        >
          {t("actions.save")}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting}
          className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium transition-colors duration-200 hover:bg-item-hover disabled:opacity-50"
        >
          {isTesting ? t("settings.notify_testing") : t("settings.notify_test")}
        </button>
        {status && (
          <span
            className={
              status.kind === "ok"
                ? "text-xs text-muted-foreground"
                : "text-xs text-destructive"
            }
          >
            {status.text}
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {t("settings.notify_hint")}
      </div>
    </section>
  );
}
