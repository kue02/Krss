import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import { useQueryClient } from "@tanstack/react-query";
import { updateGeneralSettings } from "@/api";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { useScrollReadSetting } from "@/hooks/useScrollReadSetting";
import { setUISetting, useUISettingKey, type ScrollReadMode } from "@/hooks/useUISettings";
import { setUILang } from "@/lib/ui-lang";
import { RSSHubSettings } from "./RSSHubSettings";
import { NotifySettings } from "./NotifySettings";

type Language = "zh" | "en";

export function GeneralSettings() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: generalSettings, isLoading: isGeneralSettingsLoading } =
    useGeneralSettings();
  const [fallbackUA, setFallbackUA] = useState("");
  const [autoReadability, setAutoReadability] = useState(false);
  const [markReadOnScroll, setMarkReadOnScroll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );

  useEffect(() => {
    if (!generalSettings) return;

    setFallbackUA(generalSettings.fallbackUserAgent || "");
    setAutoReadability(generalSettings.autoReadability || false);
    setMarkReadOnScroll(generalSettings.markReadOnScroll || false);
  }, [generalSettings]);

  const settingsDisabled = isGeneralSettingsLoading || !generalSettings;

  // 总开关的形态由 useScrollReadSetting 统一推导（没存过会按既有数据推导，行为不变）
  const { mode: scrollReadMode } = useScrollReadSetting();
  /** 20-3：滚过的条目先别消失（默认开，见 useScrollMarkRead 的 deferRemoval） */
  const scrollReadDeferRemoval = useUISettingKey("scrollReadDeferRemoval");

  /**
   * 12-7：本页只有「后备 UA」是要点保存的（其余开关是即时写入），
   * 所以脏判断只盯这一格；登记后切页/关设置时会问一句。
   */
  const uaDirty =
    !!generalSettings &&
    fallbackUA !== (generalSettings.fallbackUserAgent || "");
  useSettingsDirty("general", uaDirty, t("settings.dirty_label_general"), () =>
    handleSaveFallbackUA(),
  );

  const handleSaveFallbackUA = async () => {
    if (!generalSettings) return;

    setIsSaving(true);
    setSaveStatus("idle");
    try {
      await updateGeneralSettings({
        ...generalSettings,
        fallbackUserAgent: fallbackUA,
        autoReadability,
        markReadOnScroll,
      });
      queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoReadabilityChange = useCallback(
    async (checked: boolean) => {
      if (!generalSettings) return;

      setAutoReadability(checked);
      try {
        await updateGeneralSettings({
          ...generalSettings,
          fallbackUserAgent: generalSettings.fallbackUserAgent,
          autoReadability: checked,
          markReadOnScroll,
        });
        queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
      } catch {
        // Revert on error
        setAutoReadability(!checked);
      }
    },
    [generalSettings, markReadOnScroll, queryClient],
  );

  /**
   * 「滚动标已读」总开关（三态，2026-09-17 收口）：
   * - 关 / 开 → 同时把后端那个布尔一起写掉，保证「跟随通用」与其它读者口径一致；
   * - 按视图单独设 → 保持后端值不动（它就是各视图「跟随通用」的落点），
   *   真正的每视图覆盖在外观 → 按视图设置里，只有选了这一档才会出现。
   */
  const handleScrollReadModeChange = useCallback(
    async (mode: ScrollReadMode) => {
      setUISetting("scrollReadMode", mode);
      if (!generalSettings) return;

      const nextBool =
        mode === "on" ? true : mode === "off" ? false : markReadOnScroll;
      if (nextBool === markReadOnScroll) return;

      setMarkReadOnScroll(nextBool);
      try {
        await updateGeneralSettings({
          ...generalSettings,
          fallbackUserAgent: generalSettings.fallbackUserAgent,
          autoReadability,
          markReadOnScroll: nextBool,
        });
        queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
      } catch {
        setMarkReadOnScroll(!nextBool);
      }
    },
    [autoReadability, generalSettings, markReadOnScroll, queryClient],
  );

  const languageOptions = useMemo(
    () => [
      { value: "zh" as Language, label: t("language.zh") },
      { value: "en" as Language, label: t("language.en") },
    ],
    [t],
  );

  // 21 批：改语言走 lib/ui-lang（本地立即生效 + 防抖写服务端，跨设备一致）
  const changeLanguage = (lng: Language) => {
    setUILang(lng);
  };

  return (
    <div className="space-y-6">
      <RSSHubSettings />

      <NotifySettings />

      {/* Language Section */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("language.label")}</div>
            <div className="text-xs text-muted-foreground">
              {t("language.description")}
            </div>
          </div>
          <SegmentedControl
            className="shrink-0"
            value={(i18n.language as Language) || "zh"}
            onValueChange={changeLanguage}
            options={languageOptions}
          />
        </div>
      </section>

      {/* Auto Readability Section */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("settings.auto_readability")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.auto_readability_description")}
            </div>
          </div>
          <Switch
            checked={autoReadability}
            onCheckedChange={handleAutoReadabilityChange}
            disabled={settingsDisabled}
          />
        </div>
      </section>

      {/* Mark Read On Scroll Section */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("settings.mark_read_on_scroll")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.mark_read_on_scroll_description")}
            </div>
          </div>
          <SegmentedControl
            value={scrollReadMode}
            onValueChange={(value) =>
              void handleScrollReadModeChange(value as ScrollReadMode)
            }
            disabledValues={settingsDisabled ? ["off", "on", "perView"] : undefined}
            options={[
              { value: "off", label: t("settings.scroll_read_off") },
              { value: "on", label: t("settings.scroll_read_on") },
              { value: "perView", label: t("settings.scroll_read_per_view") },
            ]}
          />
        </div>
        {scrollReadMode === "perView" && (
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings.scroll_read_per_view_hint")}
          </div>
        )}
        {/* 20-3（用户 2026-09-18）：滚过的条目先别消失 —— 边滚边消失会把下面的条目往上顶 */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("settings.scroll_read_keep_visible")}
            </div>
            <div className="text-xs text-muted-foreground">
              {scrollReadMode === "off"
                ? t("settings.scroll_read_keep_visible_disabled")
                : t("settings.scroll_read_keep_visible_description")}
            </div>
          </div>
          <Switch
            checked={scrollReadDeferRemoval}
            onCheckedChange={(checked) =>
              setUISetting("scrollReadDeferRemoval", checked)
            }
            disabled={settingsDisabled || scrollReadMode === "off"}
          />
        </div>
      </section>

      {/* Advanced Section */}
      <section>
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("settings.advanced")}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("settings.fallback_ua")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.fallback_ua_description")}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <input
              type="text"
              value={fallbackUA}
              onChange={(e) => setFallbackUA(e.target.value)}
              disabled={settingsDisabled}
              placeholder={t("settings.fallback_ua_placeholder")}
              className={cn(
                "h-9 w-64 max-w-full rounded-field border border-border bg-background px-3 text-sm",
                "placeholder:text-muted-foreground/50",
                "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
              )}
            />
            <button
              type="button"
              onClick={handleSaveFallbackUA}
              disabled={isSaving || settingsDisabled}
              className={cn(
                "h-9 rounded-[var(--radius)] px-3 text-sm font-medium transition-colors shrink-0",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                saveStatus === "success" && "bg-green-600 hover:bg-green-600",
                saveStatus === "error" && "bg-destructive hover:bg-destructive",
              )}
            >
              {isSaving
                ? t("settings.saving")
                : saveStatus === "success"
                  ? t("settings.saved")
                  : t("settings.save")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
