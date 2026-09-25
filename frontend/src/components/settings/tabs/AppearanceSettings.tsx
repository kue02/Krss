import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Reorder } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useTheme,
  themes,
  type Theme,
  type ThemeOption,
  type LightThemeId,
  type DarkThemeId,
} from "@/hooks/useTheme";
import { useAppearanceSettings } from "@/hooks/useAppearanceSettings";
import {
  useUISettingActions,
  useUISettingKey,
  type CardImageSize,
  type QuoteStyle,
  type ScrollReadOverride,
  type SidebarFeedAppearance,
  type UnreadStyle,
  type RadiusPreset,
} from "@/hooks/useUISettings";
import { useScrollReadSetting } from "@/hooks/useScrollReadSetting";
import { AccentColorPicker } from "@/components/settings/tabs/AccentColorPicker";
import { UnreadBadgeCustomizer } from "@/components/settings/tabs/UnreadBadgeCustomizer";
import { readingFonts } from "@/lib/reading-fonts";
import type {
  TimelineCollapse,
  TimelineGranularity,
  TimelineTimeBasis,
} from "@/lib/timeline-model";
import { updateAppearanceSettings } from "@/api";
import { cn } from "@/lib/utils";
import { Button, Input } from "@heroui/react";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import {
  FileTextIcon,
  ImageIcon,
  BellIcon,
  EyeOffIcon,
  SocialIcon,
} from "@/components/ui/icons";
import type { ContentType } from "@/types/api";

const defaultContentTypes: ContentType[] = [
  "article",
  "picture",
  "notification",
  "social",
];

/** Nextflux 皮肤：亮/暗各一套配色的色卡选择行 */
function ThemeSwatchRow({
  title,
  options,
  value,
  onSelect,
}: {
  title: string;
  options: ThemeOption[];
  value: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();



  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="flex items-center gap-2">
        {options.map((option) => {
          const isActive = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              aria-pressed={isActive}
              title={t(`theme.themes.${option.id}`)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                isActive
                  ? "border-ring bg-item-active text-foreground"
                  : "border-border text-muted-foreground hover:bg-item-hover",
              )}
            >
              <span
                className="size-4 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: option.color }}
              />
              {t(`theme.themes.${option.id}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 设置行：左侧说明 + 右侧控件 */
function SettingRow({
  label,
  children,
  disabled = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** 该行当前不生效（如「滚动标已读」关了之后的「已读判定」）：整行变淡且不可交互 */
  disabled?: boolean;
  hint?: string;
}) {
  return (
    // 对齐 Nextflux 的设置行：min-h-12 / px-2.5 py-2 / 标签 14px
    <div
      className={cn(
        "flex min-h-12 flex-wrap items-center justify-between gap-2 px-1 py-2",
        disabled && "opacity-60",
      )}
      aria-disabled={disabled || undefined}
    >
      <div className="text-sm text-foreground">
        {label}
        {hint && (
          <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-2",
          disabled && "pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    lightTheme,
    setLightTheme,
    darkTheme,
    setDarkTheme,
  } = useTheme();
  const queryClient = useQueryClient();
  const cardImageSize = useUISettingKey("cardImageSize");
  const cardPreviewLines = useUISettingKey("cardPreviewLines");
  const entryFontFamily = useUISettingKey("entryFontFamily");
  const entryFontSize = useUISettingKey("entryFontSize");
  const entryLineHeight = useUISettingKey("entryLineHeight");
  const fetchReadableByView = useUISettingKey("fetchReadableByView");
  const splitterVisibleByView = useUISettingKey("splitterVisibleByView");
  const expandLongByView = useUISettingKey("expandLongByView");
  const reduceMotion = useUISettingKey("reduceMotion");
  const showLineNumbers = useUISettingKey("showLineNumbers");
  const uiScale = useUISettingKey("uiScale");
  const quoteStyle = useUISettingKey("quoteStyle");
  const componentRadius = useUISettingKey("componentRadius");
  const fieldRadius = useUISettingKey("fieldRadius");
  const iconRadius = useUISettingKey("iconRadius");
  const unreadStyle = useUISettingKey("unreadStyle");
  const sidebarFeedAppearance = useUISettingKey("sidebarFeedAppearance");
  const scrollReadByView = useUISettingKey("scrollReadByView");
  // 「滚动标已读」总开关形态：perView 才显示下面的按视图覆盖；off 时判定项置灰
  const { mode: scrollReadMode } = useScrollReadSetting();
  const scrollReadTimingByView = useUISettingKey("scrollReadTimingByView");
  // 第十五批：通知视图时间线的两个按视图设置（粒度 / 折叠行数）+ 窄栏合一栏
  const timelineGranularityByView = useUISettingKey("timelineGranularityByView");
  const timelineCollapseByView = useUISettingKey("timelineCollapseByView");
  // 26-2：通知视图时间线的时间基准（发布时间 / 抓取时间）
  const timelineTimeBasisByView = useUISettingKey("timelineTimeBasisByView");
  const timelineSingleSideByView = useUISettingKey("timelineSingleSideByView");
  const {
    setFetchReadableForView,
    setExpandLongForView,
    setSplitterVisibleForView,
    setReduceMotion,
    setShowLineNumbers,
    setUiScale,
    setQuoteStyle,
    setComponentRadius,
    setFieldRadius,
    setIconRadius,
    setUnreadStyle,
    setSidebarFeedAppearance,
    setScrollReadForView,
    setScrollReadTimingForView,
    setTimelineGranularityForView,
    setTimelineCollapseForView,
    setTimelineTimeBasisForView,
    setTimelineSingleSideForView,
    setCardImageSize,
    setCardPreviewLines,
    setEntryFontFamily,
    setEntryFontSize,
    setEntryLineHeight,
    setPictureLayout,
    setArticleLayout,
    setHoverRowHeight,
    setHoverImageSize,
    setGridColumns,
    setMasonryColumnWidth,
  } = useUISettingActions();
  const { data: appearanceSettings } = useAppearanceSettings();
  const pictureLayout = useUISettingKey("pictureLayout");
  const articleLayout = useUISettingKey("articleLayout");
  const hoverRowHeight = useUISettingKey("hoverRowHeight");
  const hoverImageSize = useUISettingKey("hoverImageSize");
  const gridColumns = useUISettingKey("gridColumns");
  const masonryColumnWidth = useUISettingKey("masonryColumnWidth");

  const themeOptions = useMemo(
    () => [
      {
        value: "system" as Theme,
        label: (
          <>
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            <span>{t("theme.system")}</span>
          </>
        ),
      },
      {
        value: "light" as Theme,
        label: (
          <>
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
            <span>{t("theme.light")}</span>
          </>
        ),
      },
      {
        value: "dark" as Theme,
        label: (
          <>
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
              />
            </svg>
            <span>{t("theme.dark")}</span>
          </>
        ),
      },
    ],
    [t],
  );

  const enabledContentTypes = useMemo(() => {
    const current = appearanceSettings?.contentTypes;
    if (!current || current.length === 0) return defaultContentTypes;
    return current.filter(
      (item) =>
        item === "article" ||
        item === "picture" ||
        item === "notification" ||
        item === "social",
    );
  }, [appearanceSettings]);

  const disabledContentTypes = useMemo(() => {
    return defaultContentTypes.filter(
      (type) => !enabledContentTypes.includes(type),
    );
  }, [enabledContentTypes]);

  const [orderedTypes, setOrderedTypes] =
    useState<ContentType[]>(enabledContentTypes);

  useEffect(() => {
    setOrderedTypes(enabledContentTypes);
  }, [enabledContentTypes]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveContentTypes = useCallback(
    (nextTypes: ContentType[]) => {
      if (nextTypes.length === 0) return;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await updateAppearanceSettings({ contentTypes: nextTypes });
          queryClient.invalidateQueries({ queryKey: ["appearanceSettings"] });
        } catch {
          // ignore
        }
      }, 150);
    },
    [queryClient],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleRemoveType = useCallback(
    (type: ContentType) => {
      if (orderedTypes.length <= 1) return;
      const nextTypes = orderedTypes.filter((item) => item !== type);
      setOrderedTypes(nextTypes);
      saveContentTypes(nextTypes);
    },
    [orderedTypes, saveContentTypes],
  );

  const handleAddType = useCallback(
    (type: ContentType) => {
      const nextTypes = [...orderedTypes, type];
      setOrderedTypes(nextTypes);
      saveContentTypes(nextTypes);
    },
    [orderedTypes, saveContentTypes],
  );

  const handleReorder = useCallback(
    (nextTypes: ContentType[]) => {
      setOrderedTypes(nextTypes);
      saveContentTypes(nextTypes);
    },
    [saveContentTypes],
  );

  const contentTypeMeta: Record<
    ContentType,
    { label: string; icon: ReactNode }
  > = useMemo(
    () => ({
      article: {
        label: t("content_type.article"),
        icon: <FileTextIcon className="size-4" />,
      },
      picture: {
        label: t("content_type.picture"),
        icon: <ImageIcon className="size-4" />,
      },
      notification: {
        label: t("content_type.notification"),
        icon: <BellIcon className="size-4" />,
      },
      social: {
        label: t("content_type.social"),
        icon: <SocialIcon className="size-4" />,
      },
    }),
    [t],
  );

  /**
   * 18 批：圆角档位 —— **三个旋钮共用同一套刻度**，值照 HeroUI 官方刻度
   * （`--radius`: .5rem ⇒ 直角 0 / XS 2 / SM 4 / 默认 8 / LG 10 / XL 12 / 全圆）。
   * 只有「默认档」的文案各自不同：组件圆角默认 = 出厂 8px；表单圆角默认 = 跟随组件（×1.5）；
   * 订阅图标默认 = 跟随组件（各处既有的 3/4px，12-18 用户要求与组件分开设）。
   */
  const radiusScale = [
    { value: "none", label: t("appearance_shape.radius_none") },
    { value: "xs", label: t("appearance_shape.radius_xs") },
    { value: "sm", label: t("appearance_shape.radius_sm") },
    { value: "lg", label: t("appearance_shape.radius_lg") },
    { value: "xl", label: t("appearance_shape.radius_xl") },
    { value: "full", label: t("appearance_shape.radius_full") },
  ];
  const componentRadiusOptions = [
    { value: "default", label: t("appearance_shape.radius_default_component") },
    ...radiusScale,
  ];
  const fieldRadiusOptions = [
    { value: "default", label: t("appearance_shape.radius_default_field") },
    ...radiusScale,
  ];
  const iconRadiusOptions = [
    { value: "default", label: t("appearance_shape.radius_default_icon") },
    ...radiusScale,
  ];

  return (
    <div className="space-y-6">
      {/* 主题：模式 + 配色合并成一块（2026-09-17 用户要求整理）。
          原先「主题」（跟随系统/浅色/深色）与「配色主题」（亮色配色/暗色配色）并排摆、
          都用「亮/暗」字眼，看着像同一个东西设置了两遍；现在同一张卡片里说明：
          **模式决定用哪一栏皮肤**。 */}
      <section className="rounded-lg border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("theme.label")}</div>
            <div className="text-xs text-muted-foreground">
              {t("theme.description")}
            </div>
          </div>
          <SegmentedControl
            className="shrink-0"
            value={theme}
            onValueChange={setTheme}
            options={themeOptions}
          />
        </div>
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="mb-2">
            <div className="text-sm font-medium">
              {t("theme.palette_label")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("theme.palette_description")}
            </div>
          </div>
          <div className="space-y-2.5">
            <ThemeSwatchRow
              title={t("theme.light_palette")}
              options={themes.light}
              value={lightTheme}
              onSelect={(id) => setLightTheme(id as LightThemeId)}
            />
            <ThemeSwatchRow
              title={t("theme.dark_palette")}
              options={themes.dark}
              value={darkTheme}
              onSelect={(id) => setDarkTheme(id as DarkThemeId)}
            />
          </div>
        </div>
        <div className="mt-3 border-t border-border/60 pt-3">
          <SettingRow label={t("theme.accent_color")}>
            <AccentColorPicker />
          </SettingRow>
        </div>
      </section>

      {/* 阅读与列表（对齐 Nextflux 的 Appearance / Readability）
          21 批之后这一节不再只是本机偏好：全部随服务端同步（只有「界面字号」按设备各存一套），
          所以原来那行「仅保存在本机（换设备不影响）」已经不准，已删掉。 */}
      <section>
        <div className="mb-3">
          <div className="text-sm font-medium">
            {t("appearance_reading.title")}
          </div>
        </div>

        <div className="space-y-3">
          <SettingRow label={t("appearance_reading.card_image")}>
            <SegmentedControl
              className="shrink-0"
              value={cardImageSize}
              onValueChange={(value) => setCardImageSize(value as CardImageSize)}
              options={[
                {
                  value: "none",
                  label: t("appearance_reading.card_image_none"),
                },
                {
                  value: "small",
                  label: t("appearance_reading.card_image_small"),
                },
                {
                  value: "large",
                  label: t("appearance_reading.card_image_large"),
                },
              ]}
            />
          </SettingRow>

          <SettingRow label={t("appearance_reading.preview_lines")}>
            <SegmentedControl
              className="shrink-0"
              value={String(cardPreviewLines)}
              onValueChange={(value) => setCardPreviewLines(Number(value))}
              options={[
                { value: "0", label: t("appearance_reading.none") },
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
              ]}
            />
          </SettingRow>

          <SettingRow label={t("appearance_reading.font_family")}>
            <SegmentedControl
              className="shrink-0"
              value={entryFontFamily}
              onValueChange={setEntryFontFamily}
              options={readingFonts.map((font) => ({
                value: font.value,
                label: (
                  <span style={font.stack ? { fontFamily: font.stack } : undefined}>
                    {t(`reading_font.${font.labelKey}`)}
                  </span>
                ),
              }))}
            />
          </SettingRow>

          <SettingRow label={t("appearance_reading.font_size")}>
            <SegmentedControl
              className="shrink-0"
              value={String(entryFontSize)}
              onValueChange={(value) => setEntryFontSize(Number(value))}
              options={[
                { value: "15", label: "15" },
                { value: "17", label: "17" },
                { value: "19", label: "19" },
                { value: "21", label: "21" },
              ]}
            />
          </SettingRow>

          <SettingRow label={t("appearance_reading.line_height")}>
            <SegmentedControl
              className="shrink-0"
              value={String(entryLineHeight)}
              onValueChange={(value) => setEntryLineHeight(Number(value))}
              options={[
                { value: "1.6", label: "1.6" },
                { value: "1.8", label: "1.8" },
                { value: "2", label: "2.0" },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("appearance_reading.ui_scale")}>
            <SegmentedControl
              className="shrink-0"
              value={String(uiScale)}
              onValueChange={(value) => setUiScale(Number(value))}
              options={[
                { value: "0.9", label: t("appearance_reading.ui_scale_small") },
                { value: "1", label: t("appearance_reading.ui_scale_default") },
                { value: "1.1", label: t("appearance_reading.ui_scale_large") },
                { value: "1.25", label: t("appearance_reading.ui_scale_xl") },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("appearance_reading.sidebar_feed_appearance")}>
            <SegmentedControl
              className="shrink-0"
              value={sidebarFeedAppearance}
              onValueChange={(value) =>
                setSidebarFeedAppearance(value as SidebarFeedAppearance)
              }
              options={[
                {
                  value: "default",
                  label: t("appearance_reading.sidebar_feed_default"),
                },
                {
                  value: "name_and_site",
                  label: t("appearance_reading.sidebar_feed_name_and_site"),
                },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("appearance_reading.unread_style")}>
            <div className="flex shrink-0 items-center gap-2">
              <SegmentedControl
                value={unreadStyle === "dim" ? "dim" : "badge"}
                onValueChange={(value) => setUnreadStyle(value as UnreadStyle)}
                options={[
                  {
                    value: "badge",
                    label: t("appearance_reading.unread_style_badge"),
                  },
                  { value: "dim", label: t("appearance_reading.unread_style_dim") },
                ]}
              />
              {/* 13-3：选「角标」时右侧多一个「⚙ 自定义」，点开是 HeroUI Popover 配置面板 */}
              {unreadStyle !== "dim" && <UnreadBadgeCustomizer />}
            </div>
          </SettingRow>
          <SettingRow label={t("appearance_reading.quote_style")}>
            <SegmentedControl
              className="shrink-0"
              value={quoteStyle}
              onValueChange={(value) => setQuoteStyle(value as QuoteStyle)}
              options={[
                {
                  value: "block",
                  label: t("appearance_reading.quote_style_block"),
                },
                {
                  value: "divider",
                  label: t("appearance_reading.quote_style_divider"),
                },
                {
                  value: "card",
                  label: t("appearance_reading.quote_style_card"),
                },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("appearance_reading.code_line_numbers")}>
            <SegmentedControl
              className="shrink-0"
              value={showLineNumbers ? "on" : "off"}
              onValueChange={(value) => setShowLineNumbers(value === "on")}
              options={[
                { value: "off", label: t("appearance_view.off") },
                { value: "on", label: t("appearance_view.on") },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("appearance_reading.reduce_motion")}>
            <SegmentedControl
              className="shrink-0"
              value={reduceMotion ? "on" : "off"}
              onValueChange={(value) => setReduceMotion(value === "on")}
              options={[
                { value: "off", label: t("appearance_view.off") },
                { value: "on", label: t("appearance_view.on") },
              ]}
            />
          </SettingRow>
        </div>
      </section>

      {/* 形状 —— 圆角（18 批：组件 / 表单 / 订阅图标 三个旋钮，档位照 HeroUI 官方刻度） */}
      <section>
        <div className="mb-3">
          <div className="text-sm font-medium">
            {t("appearance_shape.title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("appearance_shape.description")}
          </div>
        </div>

        <div className="space-y-3">
          <SettingRow label={t("appearance_shape.component_radius")}>
            <Select
              className="w-56 shrink-0"
              ariaLabel={t("appearance_shape.component_radius")}
              value={componentRadius}
              onChange={(value) => setComponentRadius(value as RadiusPreset)}
              options={componentRadiusOptions}
            />
          </SettingRow>
          <SettingRow label={t("appearance_shape.field_radius")}>
            <Select
              className="w-56 shrink-0"
              ariaLabel={t("appearance_shape.field_radius")}
              value={fieldRadius}
              onChange={(value) => setFieldRadius(value as RadiusPreset)}
              options={fieldRadiusOptions}
            />
          </SettingRow>
          <SettingRow label={t("appearance_shape.icon_radius")}>
            <Select
              className="w-56 shrink-0"
              ariaLabel={t("appearance_shape.icon_radius")}
              value={iconRadius}
              onChange={(value) => setIconRadius(value as RadiusPreset)}
              options={iconRadiusOptions}
            />
          </SettingRow>
        </div>

        {/*
          实时预览（照 HeroUI 主题页那套）：三个旋钮写的是 CSS 变量（--radius / --field-radius /
          --ui-icon-radius），所以这里**不需要任何联动代码** —— 旋钮一改，下面这几个现成组件当场跟着变。
          预览是只读的（不可点、不进 Tab 序），点它不会改任何设置。
        */}
        <div className="mt-3 rounded-2xl border border-border/60 p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="text-xs font-medium">
              {t("appearance_shape.preview_title")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t("appearance_shape.preview_hint")}
            </div>
          </div>
          <div inert className="flex select-none flex-wrap items-center gap-3">
            <Button size="sm" excludeFromTabOrder>
              {t("appearance_shape.preview_button")}
            </Button>
            <Input
              className="w-28"
              placeholder={t("appearance_shape.preview_input")}
              tabIndex={-1}
              readOnly
            />
            <Select
              className="w-24 shrink-0"
              ariaLabel={t("appearance_shape.preview_select")}
              value="preview"
              onChange={() => {}}
              options={[
                { value: "preview", label: t("appearance_shape.preview_select") },
              ]}
            />
            {/* 卡片照 HeroUI 自己的规则：`min(32px, var(--radius-3xl))`（card.css 就是这条），
                所以它跟着「组件圆角」走、并且在 XL 那档封顶在 32px */}
            <div
              className="border border-border bg-card px-3 py-2 text-xs"
              style={{ borderRadius: "min(32px, var(--radius-3xl))" }}
            >
              {t("appearance_shape.preview_card")}
            </div>
            <span
              title={t("appearance_shape.preview_icon")}
              className="flex items-center gap-1.5"
            >
              {/* 两个都是真实抓下来的 favicon（一次性从现有源里挑的样本，已打包进前端）：
                  左边本身是圆形 logo、右边本身是方形 —— 真实图标就长这样，比兜底的 RSS 图标好认 */}
              <FeedAvatar src="/preview-icons/feed-round.png" size={20} />
              <FeedAvatar src="/preview-icons/feed-square.png" size={20} />
            </span>
          </div>
        </div>
      </section>

      {/* 按视图设置 —— 每个视图（文章 / 图片 / 通知）独立控制 */}
      <section>
        <div className="mb-3">
          <div className="text-sm font-medium">
            {t("appearance_view.title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("appearance_view.description")}
          </div>
        </div>

        <div className="space-y-3">
          {(
            ["article", "picture", "notification", "social"] as ContentType[]
          ).map(
            (view) => (
              <div
                key={view}
                className="space-y-1 overflow-hidden rounded-xl bg-card/40 p-2 shadow-nf"
              >
                <div className="text-xs font-semibold text-foreground">
                  {t(`content_type.${view}`)}
                </div>
                {/* 第一栏的分界限按视图显示（用户 11-7：图片/社交媒体里可以不显示） */}
                <SettingRow label={t("appearance_view.show_splitter")}>
                  <SegmentedControl
                    className="shrink-0"
                    value={splitterVisibleByView?.[view] === false ? "off" : "on"}
                    onValueChange={(value) =>
                      setSplitterVisibleForView(view, value === "on")
                    }
                    options={[
                      { value: "off", label: t("appearance_view.off") },
                      { value: "on", label: t("appearance_view.on") },
                    ]}
                  />
                </SettingRow>
                {view === "social" && (
                  <SettingRow label={t("appearance_view.expand_long")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={expandLongByView[view] ? "on" : "off"}
                      onValueChange={(value) =>
                        setExpandLongForView(view, value === "on")
                      }
                      options={[
                        { value: "off", label: t("appearance_view.off") },
                        { value: "on", label: t("appearance_view.on") },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 第十五批：通知视图 = 时间线（没有「切回列表」这一项 —— 形态只有这一种），
                    能调的只有时间粒度与卡片折叠行数，两项都只影响分组/标注与显示行数，
                    不重新请求数据（分页仍是 limit+1） */}
                {view === "notification" && (
                  <>
                    <SettingRow
                      label={t("appearance_view.timeline_granularity")}
                      hint={t("appearance_view.timeline_granularity_hint")}
                    >
                      <SegmentedControl
                        className="shrink-0"
                        value={timelineGranularityByView?.[view] ?? "hour"}
                        onValueChange={(value) =>
                          setTimelineGranularityForView(
                            view,
                            value as TimelineGranularity,
                          )
                        }
                        options={[
                          {
                            value: "minute",
                            label: t("appearance_view.timeline_granularity_minute"),
                          },
                          {
                            value: "quarter",
                            label: t("appearance_view.timeline_granularity_quarter"),
                          },
                          {
                            value: "hour",
                            label: t("appearance_view.timeline_granularity_hour"),
                          },
                          {
                            value: "day",
                            label: t("appearance_view.timeline_granularity_day"),
                          },
                        ]}
                      />
                    </SettingRow>
                    {/* 26-2：时间基准（发布时间默认 = 现状 / 抓取时间 = 刷新批次），
                        紧挨「时间粒度」—— 只影响分组/排序/标注，不重新请求数据 */}
                    <SettingRow
                      label={t("appearance_view.timeline_time_basis")}
                      hint={t("appearance_view.timeline_time_basis_hint")}
                    >
                      <SegmentedControl
                        className="shrink-0"
                        value={timelineTimeBasisByView?.[view] ?? "published"}
                        onValueChange={(value) =>
                          setTimelineTimeBasisForView(
                            view,
                            value as TimelineTimeBasis,
                          )
                        }
                        options={[
                          {
                            value: "published",
                            label: t("appearance_view.timeline_time_basis_published"),
                          },
                          {
                            value: "fetched",
                            label: t("appearance_view.timeline_time_basis_fetched"),
                          },
                        ]}
                      />
                    </SettingRow>
                    <SettingRow
                      label={t("appearance_view.timeline_collapse")}
                      hint={t("appearance_view.timeline_collapse_hint")}
                    >
                      <SegmentedControl
                        className="shrink-0"
                        value={timelineCollapseByView?.[view] ?? "2"}
                        onValueChange={(value) =>
                          setTimelineCollapseForView(view, value as TimelineCollapse)
                        }
                        options={[
                          { value: "1", label: t("appearance_view.timeline_lines_1") },
                          { value: "2", label: t("appearance_view.timeline_lines_2") },
                          { value: "3", label: t("appearance_view.timeline_lines_3") },
                          {
                            value: "full",
                            label: t("appearance_view.timeline_lines_full"),
                          },
                        ]}
                      />
                    </SettingRow>
                    <SettingRow
                      label={t("appearance_view.timeline_single_side")}
                      hint={t("appearance_view.timeline_single_side_hint")}
                    >
                      <SegmentedControl
                        className="shrink-0"
                        value={
                          timelineSingleSideByView?.[view] === false ? "off" : "on"
                        }
                        onValueChange={(value) =>
                          setTimelineSingleSideForView(view, value === "on")
                        }
                        options={[
                          { value: "off", label: t("appearance_view.off") },
                          { value: "on", label: t("appearance_view.on") },
                        ]}
                      />
                    </SettingRow>
                  </>
                )}
                {/* 「缺全文时自动抓取」只对文章类开放：社交链接抓回的是登录墙 */}
                {view === "article" && (
                  <SettingRow label={t("appearance_view.fetch_readable")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={fetchReadableByView[view] ? "on" : "off"}
                      onValueChange={(value) =>
                        setFetchReadableForView(view, value === "on")
                      }
                      options={[
                        { value: "off", label: t("appearance_view.off") },
                        { value: "on", label: t("appearance_view.on") },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 文章视图：卡片列表（默认）/ 悬停大图（同图片视图第三档形态；\n                    点击用 Nextflux 式推进转场把正文推进第三栏）。reader-transition 批新增 */ }
                {view === "article" && (
                  <SettingRow
                    label={t("appearance_view.article_layout")}
                    hint={t("appearance_view.article_layout_hover_hint")}
                  >
                    <SegmentedControl
                      className="shrink-0"
                      value={articleLayout}
                      onValueChange={(value) =>
                        setArticleLayout(value as "list" | "hover")
                      }
                      options={[
                        {
                          value: "list",
                          label: t("appearance_view.article_layout_list"),
                        },
                        {
                          value: "hover",
                          label: t("appearance_view.article_layout_hover"),
                        },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 图片视图：瀑布流 / 等高正方格（用户 2026-09-17 要求加这一档） */}
                {view === "picture" && (
                  <SettingRow label={t("appearance_view.picture_layout")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={pictureLayout}
                      onValueChange={(value) =>
                        setPictureLayout(value as "masonry" | "grid")
                      }
                      options={[
                        {
                          value: "masonry",
                          label: t("appearance_view.picture_layout_masonry"),
                        },
                        {
                          value: "grid",
                          label: t("appearance_view.picture_layout_grid"),
                        },
                        {
                          value: "hover",
                          label: t("appearance_view.picture_layout_hover"),
                        },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 28-7c：网格档列数 / 瀑布流档列宽 —— 两个可调项（用户「做两个可调项」），
                    各自按当前档位显示。瀑布流那个按「列宽固定、列数随宽度变」实现 Pinterest 观感。 */}
                {view === "picture" && pictureLayout === "grid" && (
                  <SettingRow label={t("appearance_view.grid_columns")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={String(gridColumns)}
                      onValueChange={(value) =>
                        setGridColumns(value as "auto" | "2" | "3" | "4" | "5" | "6")
                      }
                      options={[
                        { value: "auto", label: t("appearance_view.grid_columns_auto") },
                        { value: "2", label: "2" },
                        { value: "3", label: "3" },
                        { value: "4", label: "4" },
                        { value: "5", label: "5" },
                        { value: "6", label: "6" },
                      ]}
                    />
                  </SettingRow>
                )}
                {view === "picture" && pictureLayout === "masonry" && (
                  <SettingRow label={t("appearance_view.masonry_column_width")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={String(masonryColumnWidth)}
                      onValueChange={(value) =>
                        setMasonryColumnWidth(
                          value as "auto" | "180" | "220" | "260",
                        )
                      }
                      options={[
                        {
                          value: "auto",
                          label: t("appearance_view.masonry_column_width_auto"),
                        },
                        {
                          value: "180",
                          label: t("appearance_view.masonry_column_width_narrow"),
                        },
                        {
                          value: "220",
                          label: t("appearance_view.masonry_column_width_mid"),
                        },
                        {
                          value: "260",
                          label: t("appearance_view.masonry_column_width_wide"),
                        },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 28-7a：悬停大图档的尺寸自定义（用户 2026-09-25 要求这两项可设置，
                    预设来自两棵树：compact/small = 5179 现值，comfortable/large = 5175 那套） */}
                {view === "picture" && pictureLayout === "hover" && (
                  <>
                    <SettingRow label={t("appearance_view.hover_row_height")}>
                      <SegmentedControl
                        className="shrink-0"
                        value={hoverRowHeight}
                        onValueChange={(value) =>
                          setHoverRowHeight(value as "compact" | "comfortable")
                        }
                        options={[
                          {
                            value: "compact",
                            label: t("appearance_view.hover_row_height_compact"),
                          },
                          {
                            value: "comfortable",
                            label: t(
                              "appearance_view.hover_row_height_comfortable",
                            ),
                          },
                        ]}
                      />
                    </SettingRow>
                    <SettingRow label={t("appearance_view.hover_image_size")}>
                      <SegmentedControl
                        className="shrink-0"
                        value={hoverImageSize}
                        onValueChange={(value) =>
                          setHoverImageSize(value as "small" | "large")
                        }
                        options={[
                          {
                            value: "small",
                            label: t("appearance_view.hover_image_size_small"),
                          },
                          {
                            value: "large",
                            label: t("appearance_view.hover_image_size_large"),
                          },
                        ]}
                      />
                    </SettingRow>
                  </>
                )}
                {/* 按视图覆盖只在总开关选了「按视图单独设」时出现 ——
                    否则这里能和通用里的总开关打架（用户 2026-09-17 要求收口） */}
                {scrollReadMode === "perView" && (
                  <SettingRow label={t("appearance_view.scroll_read")}>
                    <SegmentedControl
                      className="shrink-0"
                      value={scrollReadByView[view]}
                      onValueChange={(value) =>
                        setScrollReadForView(view, value as ScrollReadOverride)
                      }
                      options={[
                        { value: "inherit", label: t("appearance_view.inherit") },
                        { value: "on", label: t("appearance_view.on") },
                        { value: "off", label: t("appearance_view.off") },
                      ]}
                    />
                  </SettingRow>
                )}
                {/* 已读判定时机：滚出顶部（默认）／看到即已读（对齐 Folo 的 useEntryMarkReadHandler）。
                    总开关把「滚动标已读」关掉时这一项不再生效 → 置灰 + 说明原因（用户 2026-09-17 要求联动） */}
                <SettingRow
                  label={t("appearance_view.read_timing")}
                  disabled={scrollReadMode === "off"}
                  hint={
                    scrollReadMode === "off"
                      ? t("appearance_view.read_timing_disabled")
                      : undefined
                  }
                >
                  <SegmentedControl
                    className="shrink-0"
                    value={scrollReadTimingByView?.[view] ?? "scrollPast"}
                    onValueChange={(value) =>
                      setScrollReadTimingForView(view, value as "scrollPast" | "onVisible")
                    }
                    options={[
                      { value: "scrollPast", label: t("appearance_view.timing_scroll_past") },
                      { value: "onVisible", label: t("appearance_view.timing_on_visible") },
                    ]}
                  />
                </SettingRow>
              </div>
            ),
          )}
        </div>
      </section>

      {/* Category View Section */}
      <section>
        <div className="mb-3">
          <div className="text-sm font-medium">
            {t("settings.appearance_categories")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.appearance_categories_description")}
          </div>
        </div>

        <div className="space-y-3">
          {/* Horizontal draggable chips */}
          <div className="flex flex-wrap gap-2">
            <Reorder.Group
              axis="x"
              values={orderedTypes}
              onReorder={handleReorder}
              className="flex flex-wrap gap-2"
              aria-label={t("settings.appearance_categories")}
            >
              {orderedTypes.map((type) => {
                const meta = contentTypeMeta[type];
                const isOnlyOne = orderedTypes.length <= 1;
                return (
                  <Reorder.Item
                    key={type}
                    value={type}
                    drag="x"
                    dragElastic={0}
                    dragTransition={{ bounceStiffness: 600, bounceDamping: 50 }}
                    transition={{ duration: 0.15 }}
                    className={cn(
                      "flex cursor-grab items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2",
                      "hover:border-border hover:shadow-sm",
                      "active:cursor-grabbing active:shadow-md active:z-10",
                    )}
                    aria-roledescription={t("settings.appearance_drag")}
                  >
                    {/* Icon */}
                    <span className="text-muted-foreground">{meta.icon}</span>
                    {/* Label */}
                    <span className="text-sm font-medium">{meta.label}</span>
                    {/* Hide button */}
                    {!isOnlyOne && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveType(type);
                        }}
                        className={cn(
                          "ml-1 flex size-5 items-center justify-center rounded-[var(--radius)]",
                          "text-muted-foreground/50 transition-colors",
                          "hover:bg-destructive/10 hover:text-destructive",
                        )}
                        title={t("settings.appearance_hide")}
                      >
                        <EyeOffIcon className="size-3.5" />
                      </button>
                    )}
                  </Reorder.Item>
                );
              })}
            </Reorder.Group>
          </div>

          {/* Hidden types */}
          {disabledContentTypes.length > 0 && (
            <div>
              <div className="mb-2 text-xs text-muted-foreground">
                {t("settings.appearance_hidden")}
              </div>
              <div className="flex flex-wrap gap-2">
                {disabledContentTypes.map((type) => {
                  const meta = contentTypeMeta[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleAddType(type)}
                      className={cn(
                        "flex items-center gap-2 rounded-[var(--radius)] border border-dashed border-border/50 px-3 py-2",
                        "text-muted-foreground/60 transition-colors",
                        "hover:border-primary/50 hover:bg-primary/5 hover:text-foreground",
                      )}
                    >
                      <span>{meta.icon}</span>
                      <span className="text-sm font-medium">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {orderedTypes.length <= 1 && (
            <div className="text-xs text-muted-foreground">
              {t("settings.appearance_keep_one")}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
