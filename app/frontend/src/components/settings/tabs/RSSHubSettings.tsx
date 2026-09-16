import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateFeedUrl, updateGeneralSettings } from "@/api";
import { useFeeds } from "@/hooks/useFeeds";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { rewriteRssHubUrl } from "@/lib/rsshub";
import { queryClient } from "@/lib/queryClient";
import { showToast } from "@/stores/toast-store";

interface PendingRewrite {
  feedId: string;
  title: string;
  from: string;
  to: string;
}

/**
 * RSSHub 适配：填自有实例地址（可带 ACCESS_KEY）。
 * - 之后添加订阅时，RSSHub 地址会自动换到该实例
 * - 「预览」列出会被改写的现有订阅，「应用」一次性换掉
 */
export function RSSHubSettings() {
  const { t } = useTranslation();
  const { data: generalSettings } = useGeneralSettings();
  const { data: feeds = [] } = useFeeds();
  const [baseUrl, setBaseUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!generalSettings) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setBaseUrl(generalSettings.rsshubBaseUrl ?? "");
    setAccessKey(generalSettings.rsshubAccessKey ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [generalSettings]);

  const savedBaseUrl = generalSettings?.rsshubBaseUrl ?? "";
  const savedAccessKey = generalSettings?.rsshubAccessKey ?? "";
  const isDirty = baseUrl !== savedBaseUrl || accessKey !== savedAccessKey;

  const pending = useMemo<PendingRewrite[]>(() => {
    const target = baseUrl.trim();
    if (!target) return [];

    return feeds.flatMap((feed) => {
      const next = rewriteRssHubUrl(feed.url, target, accessKey);
      if (!next || next === feed.url) return [];
      return [{ feedId: feed.id, title: feed.title, from: feed.url, to: next }];
    });
  }, [accessKey, baseUrl, feeds]);

  const handleSave = useCallback(async () => {
    if (!generalSettings) return;

    setIsSaving(true);
    try {
      await updateGeneralSettings({
        fallbackUserAgent: generalSettings.fallbackUserAgent,
        autoReadability: generalSettings.autoReadability,
        markReadOnScroll: generalSettings.markReadOnScroll,
        rsshubBaseUrl: baseUrl.trim(),
        rsshubAccessKey: accessKey.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
      setShowPreview(false);
      showToast(t("settings.rsshub_saved"));
    } catch {
      showToast(t("settings.rsshub_save_failed"));
    } finally {
      setIsSaving(false);
    }
  }, [accessKey, baseUrl, generalSettings, t]);

  const handleApply = useCallback(async () => {
    if (pending.length === 0) return;

    setIsApplying(true);
    let changed = 0;
    for (const item of pending) {
      try {
        await updateFeedUrl(item.feedId, item.to);
        changed += 1;
      } catch {
        // 单条失败不影响其余，最后统一汇报
      }
    }
    setIsApplying(false);
    setShowPreview(false);
    queryClient.invalidateQueries({ queryKey: ["feeds"] });
    queryClient.invalidateQueries({ queryKey: ["entries"] });

    if (changed === pending.length) {
      showToast(t("settings.rsshub_applied", { count: changed }));
    } else {
      showToast(
        t("settings.rsshub_applied_partial", {
          changed,
          total: pending.length,
        }),
      );
    }
  }, [pending, t]);

  return (
    <section className="space-y-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("settings.rsshub_label")}</div>
        <div className="text-xs text-muted-foreground">
          {t("settings.rsshub_description")}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://rsshub.example.com"
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent"
        />
        <input
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
          placeholder={t("settings.rsshub_access_key_placeholder")}
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent sm:max-w-[220px]"
        />
      </div>

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
          onClick={() => setShowPreview((value) => !value)}
          disabled={!baseUrl.trim()}
          className="rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground disabled:opacity-50"
        >
          {showPreview
            ? t("settings.rsshub_hide_preview")
            : t("settings.rsshub_preview", { count: pending.length })}
        </button>
        {pending.length > 0 && (
          <button
            type="button"
            onClick={handleApply}
            disabled={isApplying}
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium transition-colors duration-200 hover:bg-item-hover disabled:opacity-50"
          >
            {isApplying
              ? t("settings.rsshub_applying")
              : t("settings.rsshub_apply", { count: pending.length })}
          </button>
        )}
      </div>

      {showPreview && (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-surface/60 p-2">
          {pending.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("settings.rsshub_nothing_to_migrate")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {pending.map((item) => (
                <li key={item.feedId} className="px-2 py-1.5 text-xs">
                  <div className="font-medium text-foreground">{item.title}</div>
                  <div className="break-all text-muted-foreground">
                    {item.from}
                  </div>
                  <div className="break-all text-accent">{item.to}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
