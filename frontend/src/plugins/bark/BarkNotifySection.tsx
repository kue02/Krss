import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import { ApiError } from "@/api";
import {
  fetchPluginSettings,
  savePluginSettings,
  testPluginAction,
} from "@/plugins/api";

/**
 * 推送（Bark）插件设置段（55-13 从「设置 → 通用」的 NotifySettings 搬来）。
 *
 * 地址是**插件自己的设置**（键 plugin.bark.url），不再是通用设置的一个字段：
 * 读出接口给的是掩码（地址带设备 key，属凭证），原样回存 = 保持原值不变。
 * 测试按钮走插件的动作测试接口 `/api/plugins/bark/actions/notify/test` ——
 * 与规则命中时是同一条发送路径，所以它通了就说明地址、代理、出网都对。
 */
const PLUGIN_ID = "bark";
const ACTION_ID = "notify";
/** 与后端 service.PluginMaskedValue 一致：读到这个值表示「已存过，但看不到明文」 */
const MASKED_VALUE = "••••••••";

export function BarkNotifySection() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPluginSettings(PLUGIN_ID)
      .then((values) => {
        if (!alive) return;
        const stored = values.url ?? "";
        setUrl(stored);
        setSavedUrl(stored);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatus({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  const isDirty = url.trim() !== savedUrl;

  const save = useCallback(async (nextUrl: string): Promise<string> => {
    const values = await savePluginSettings(PLUGIN_ID, { url: nextUrl });
    const stored = values.url ?? "";
    setUrl(stored);
    setSavedUrl(stored);
    return stored;
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      await save(url.trim());
      setStatus({ kind: "ok", text: t("plugins.bark.saved") });
    } catch (error) {
      setStatus({
        kind: "error",
        text:
          error instanceof ApiError
            ? error.message
            : t("plugins.bark.save_failed"),
      });
    } finally {
      setIsSaving(false);
    }
  }, [save, t, url]);

  // 12-7：把「这一段有未保存改动」登记给设置弹窗（切页/关闭时问一句）
  useSettingsDirty("bark", isDirty, t("plugins.bark.dirty_label"), handleSave);

  const handleTest = useCallback(async () => {
    // 没填地址也不把按钮置灰 —— 点了没反应是最难查的失败；这里给一句可见原因
    if (!url.trim() && !savedUrl) {
      setStatus({ kind: "error", text: t("plugins.bark.test_no_url") });
      return;
    }
    setIsTesting(true);
    setStatus(null);
    try {
      // 改了地址就先存再测，免得多点一次还不知道测的是哪份
      if (isDirty) {
        await save(url.trim());
      }
      await testPluginAction(PLUGIN_ID, ACTION_ID);
      setStatus({ kind: "ok", text: t("plugins.bark.test_ok") });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setStatus({ kind: "error", text: t("plugins.bark.test_no_url") });
      } else {
        setStatus({
          kind: "error",
          text:
            error instanceof ApiError
              ? t("plugins.bark.test_failed", { reason: error.message })
              : t("plugins.bark.test_failed", {
                  reason: (error as Error).message,
                }),
        });
      }
    } finally {
      setIsTesting(false);
    }
  }, [isDirty, save, t, url, savedUrl]);

  return (
    <section className="space-y-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("plugins.bark.label")}</div>
        <div className="text-xs text-muted-foreground">
          {t("plugins.bark.description")}
        </div>
      </div>

      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://api.day.app/your-key"
        className="w-full rounded-field border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent"
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
          {isTesting ? t("plugins.bark.testing") : t("plugins.bark.test")}
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
    </section>
  );
}

/** 掩码值导出给单测用（后端漏掩码时这条测试会先炸，不靠肉眼） */
export { MASKED_VALUE };
