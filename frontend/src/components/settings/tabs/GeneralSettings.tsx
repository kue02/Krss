import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import { useQueryClient } from "@tanstack/react-query";
import { updateGeneralSettings } from "@/api";
import { cn } from "@/lib/utils";
import { BookOpenText, Languages, ScrollText, Wrench } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { useScrollReadSetting } from "@/hooks/useScrollReadSetting";
import { VideoEmbedSettings } from "@/components/settings/tabs/VideoEmbedSettings";
import { setUISetting, useUISettingKey, type ScrollReadMode } from "@/hooks/useUISettings";
import { setUILang } from "@/lib/ui-lang";

type Language = "zh" | "en";

export function GeneralSettings() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: generalSettings, isLoading: isGeneralSettingsLoading } =
    useGeneralSettings();
  const [fallbackUA, setFallbackUA] = useState("");
  /** 插件导出的落盘目录（空 = 走浏览器下载）；与 UA 同属「点保存」这一档 */
  const [exportDir, setExportDir] = useState("");
  const [autoReadability, setAutoReadability] = useState(false);
  const [markReadOnScroll, setMarkReadOnScroll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );

  useEffect(() => {
    if (!generalSettings) return;

    setFallbackUA(generalSettings.fallbackUserAgent || "");
    setExportDir(generalSettings.exportDir || "");
    setAutoReadability(generalSettings.autoReadability || false);
    setMarkReadOnScroll(generalSettings.markReadOnScroll || false);
  }, [generalSettings]);

  const settingsDisabled = isGeneralSettingsLoading || !generalSettings;

  /**
   * 「滚动标已读」的口径（2026-10-09 用户拍板改法 A）：
   * 通用这一档只是**默认值**（后端 `markReadOnScroll`），按视图覆盖永远优先。
   * 所以这里只需要三件事：默认是否开着 / 有几个视图被单独设过 / 还有没有任何视图会滚动标已读。
   */
  const {
    globalOn: scrollReadGlobalOn,
    overrideCount: scrollReadOverrideCount,
    anyViewEnabled: scrollReadAnyEnabled,
  } = useScrollReadSetting();
  /** 20-3：滚过的条目先别消失（默认开，见 useScrollMarkRead 的 deferRemoval） */
  const scrollReadDeferRemoval = useUISettingKey("scrollReadDeferRemoval");

  /**
   * 12-7：本页只有「后备 UA」是要点保存的（其余开关是即时写入），
   * 所以脏判断只盯这一格；登记后切页/关设置时会问一句。
   */
  const uaDirty =
    !!generalSettings &&
    (fallbackUA !== (generalSettings.fallbackUserAgent || "") ||
      exportDir !== (generalSettings.exportDir || ""));
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
        exportDir,
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
          exportDir: generalSettings.exportDir ?? "",
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
   * 「滚动标已读」的默认档（2026-10-09 改法 A）：只有 关 / 开 两档 ——
   * 它写的是**默认值**（后端那个布尔，没单独设置过的视图跟它走）；
   * 单个视图的覆盖在 外观 → 按视图设置 里，改那边不会再动这个默认值。
   */
  const handleScrollReadModeChange = useCallback(
    async (mode: ScrollReadMode) => {
      setUISetting("scrollReadMode", mode);
      if (!generalSettings) return;

      const nextBool = mode === "on";
      if (nextBool === markReadOnScroll) return;

      setMarkReadOnScroll(nextBool);
      try {
        await updateGeneralSettings({
          ...generalSettings,
          fallbackUserAgent: generalSettings.fallbackUserAgent,
          exportDir: generalSettings.exportDir ?? "",
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

  const inputClass =
    "h-9 w-full min-w-0 rounded-field border border-border bg-background px-3 text-sm focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none";

  return (
    <div className="space-y-5">
      {/* 语言 */}
      <SectionCard
        icon={<Languages className="size-4" strokeWidth={1.75} />}
        title={t("language.label")}
        description={t("language.description")}
        action={
          <SegmentedControl
            className="shrink-0"
            value={(i18n.language as Language) || "zh"}
            onValueChange={changeLanguage}
            options={languageOptions}
          />
        }
      >
        {null}
      </SectionCard>

      {/* 自动开启阅读模式 */}
      <SectionCard
        icon={<BookOpenText className="size-4" strokeWidth={1.75} />}
        title={t("settings.auto_readability")}
        description={t("settings.auto_readability_description")}
        action={
          <Switch
            className="shrink-0"
            checked={autoReadability}
            onCheckedChange={handleAutoReadabilityChange}
            disabled={settingsDisabled}
          />
        }
      >
        {null}
      </SectionCard>

      {/* 滚动标已读（默认档） */}
      <SectionCard
        icon={<ScrollText className="size-4" strokeWidth={1.75} />}
        title={t("settings.mark_read_on_scroll")}
        description={t("settings.mark_read_on_scroll_description")}
        action={
          <SegmentedControl
            className="shrink-0"
            value={scrollReadGlobalOn ? "on" : "off"}
            onValueChange={(value) =>
              void handleScrollReadModeChange(value as ScrollReadMode)
            }
            disabledValues={settingsDisabled ? ["off", "on"] : undefined}
            options={[
              { value: "off", label: t("settings.scroll_read_off") },
              { value: "on", label: t("settings.scroll_read_on") },
            ]}
          />
        }
      >
        <div className="divide-y divide-border/50">
          {/* 2026-10-09 改法 A：这一档不再有「按视图单独设」——单个视图在外观里直接改，
              改了就自动生效，不用先来这里开门。有几个视图被单独设过就在下面说一句。 */}
          {scrollReadOverrideCount > 0 && (
            <div className="px-1 py-2.5 text-xs text-muted-foreground">
              {t("settings.scroll_read_per_view_count", {
                count: scrollReadOverrideCount,
              })}
            </div>
          )}
          {/* 20-3（用户 2026-09-18）：滚过的条目先别消失 —— 边滚边消失会把下面的条目往上顶 */}
          <SettingRow
            label={t("settings.scroll_read_keep_visible")}
            hint={
              scrollReadAnyEnabled
                ? t("settings.scroll_read_keep_visible_description")
                : t("settings.scroll_read_keep_visible_disabled")
            }
            disabled={!scrollReadAnyEnabled}
          >
            <Switch
              checked={scrollReadDeferRemoval}
              onCheckedChange={(checked) =>
                setUISetting("scrollReadDeferRemoval", checked)
              }
              disabled={settingsDisabled || !scrollReadAnyEnabled}
            />
          </SettingRow>
        </div>
      </SectionCard>

      {/* 正文视频：白名单 / 未知站点点击加载；直接视频文件无需配置 */}
      <VideoEmbedSettings />

      {/* 高级 */}
      <SectionCard
        icon={<Wrench className="size-4" strokeWidth={1.75} />}
        title={t("settings.advanced")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("settings.export_dir")}
            hint={t("settings.export_dir_description")}
          >
            <input
              type="text"
              value={exportDir}
              onChange={(e) => setExportDir(e.target.value)}
              disabled={settingsDisabled}
              placeholder={t("settings.export_dir_placeholder")}
              className={cn(inputClass, "w-64 max-w-full shrink-0")}
            />
          </SettingRow>
          <SettingRow
            label={t("settings.fallback_ua")}
            hint={t("settings.fallback_ua_description")}
          >
            <input
              type="text"
              value={fallbackUA}
              onChange={(e) => setFallbackUA(e.target.value)}
              disabled={settingsDisabled}
              placeholder={t("settings.fallback_ua_placeholder")}
              className={cn(inputClass, "w-64 max-w-full shrink-0")}
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
          </SettingRow>
        </div>
      </SectionCard>
    </div>
  );
}
