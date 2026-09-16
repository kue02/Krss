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
} from "@/hooks/useUISettings";
import { readingFonts } from "@/lib/reading-fonts";
import { updateAppearanceSettings } from "@/api";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  FileTextIcon,
  ImageIcon,
  BellIcon,
  EyeOffIcon,
} from "@/components/ui/icons";
import type { ContentType } from "@/types/api";

const defaultContentTypes: ContentType[] = [
  "article",
  "picture",
  "notification",
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
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">{children}</div>
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
  const {
    setCardImageSize,
    setCardPreviewLines,
    setEntryFontFamily,
    setEntryFontSize,
    setEntryLineHeight,
  } = useUISettingActions();
  const { data: appearanceSettings } = useAppearanceSettings();

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
        item === "article" || item === "picture" || item === "notification",
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
    }),
    [t],
  );

  return (
    <div className="space-y-6">
      {/* Theme Section */}
      <section>
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
      </section>

      {/* Palette Section — Nextflux 配色 */}
      <section>
        <div className="mb-3">
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
      </section>

      {/* 阅读与列表 —— 本机偏好（对齐 Nextflux 的 Appearance / Readability） */}
      <section>
        <div className="mb-3">
          <div className="text-sm font-medium">
            {t("appearance_reading.title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("appearance_reading.description")}
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
                          "ml-1 flex size-5 items-center justify-center rounded-md",
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
                        "flex items-center gap-2 rounded-lg border border-dashed border-border/50 px-3 py-2",
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
