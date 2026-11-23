import { Minus, Plus, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { readingFonts, resolveReadingFontStack } from "@/lib/reading-fonts";
import {
  ENTRY_FONT_SIZE_MAX,
  ENTRY_FONT_SIZE_MIN,
  ENTRY_LINE_HEIGHT_MAX,
  ENTRY_LINE_HEIGHT_MIN,
  useUISettingActions,
  useUISettingKey,
} from "@/hooks/useUISettings";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { MobileActionSheet } from "./MobileActionSheet";

interface MobileReadingSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const THEMES: Theme[] = ["system", "light", "dark"];

function ChoiceButton({
  active,
  children,
  onClick,
  className,
  style,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={style}
      className={cn(
        "flex min-h-11 items-center justify-center rounded-xl border px-2 text-xs font-medium transition-colors",
        active
          ? "border-accent/50 bg-accent/10 text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground active:bg-item-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 正文页「阅读设置」：字体、字号、行距、主题与实时预览。 */
export function MobileReadingSettings({
  open,
  onOpenChange,
}: MobileReadingSettingsProps) {
  const { t } = useTranslation();
  const entryFontFamily = useUISettingKey("entryFontFamily");
  const entryFontSize = useUISettingKey("entryFontSize");
  const entryLineHeight = useUISettingKey("entryLineHeight");
  const { setEntryFontFamily, setEntryFontSize, setEntryLineHeight } =
    useUISettingActions();
  const { theme, setTheme } = useTheme();

  // 字号 / 行高是跨设备同步的数值（桌面用数字步进器可到任意整数/一位小数），
  // 手机端不能再按下标走固定几档，否则桌面设成 18 时 indexOf 得到 -1。改成算术步进，
  // 与桌面同一区间；真实夹取交给 setter（见 useUISettings 的 clampEntryFontSize/LineHeight）。
  const fontStack = resolveReadingFontStack(entryFontFamily);

  const atMinSize = entryFontSize <= ENTRY_FONT_SIZE_MIN;
  const atMaxSize = entryFontSize >= ENTRY_FONT_SIZE_MAX;
  const atMinLineHeight = entryLineHeight <= ENTRY_LINE_HEIGHT_MIN + 1e-6;
  const atMaxLineHeight = entryLineHeight >= ENTRY_LINE_HEIGHT_MAX - 1e-6;

  const stepSize = (direction: -1 | 1) => {
    setEntryFontSize(entryFontSize + direction);
  };

  const stepLineHeight = (direction: -1 | 1) => {
    setEntryLineHeight(entryLineHeight + direction * 0.1);
  };

  return (
    <MobileActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("entry.reading_settings")}
    >
      <div className="space-y-6 px-5 pb-2 pt-1">
        <section aria-labelledby="mobile-reading-font">
          <h3
            id="mobile-reading-font"
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            {t("appearance_reading.font_family")}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {readingFonts.map((font) => (
              <ChoiceButton
                key={font.value || "theme_default"}
                active={entryFontFamily === font.value}
                onClick={() => setEntryFontFamily(font.value)}
                style={font.stack ? { fontFamily: font.stack } : undefined}
              >
                {t(`reading_font.${font.labelKey}`)}
              </ChoiceButton>
            ))}
          </div>
        </section>

        <section aria-labelledby="mobile-reading-size">
          <h3
            id="mobile-reading-size"
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            {t("appearance_reading.font_size")}
          </h3>
          <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-default/30 p-1">
            <button
              type="button"
              aria-label={t("entry.decrease_font_size")}
              disabled={atMinSize}
              onClick={() => stepSize(-1)}
              className="flex size-11 items-center justify-center rounded-xl text-foreground active:bg-item-hover disabled:opacity-35"
            >
              <Minus className="size-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {entryFontSize}px
            </span>
            <button
              type="button"
              aria-label={t("entry.increase_font_size")}
              disabled={atMaxSize}
              onClick={() => stepSize(1)}
              className="flex size-11 items-center justify-center rounded-xl text-foreground active:bg-item-hover disabled:opacity-35"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </section>

        <section aria-labelledby="mobile-reading-leading">
          <h3
            id="mobile-reading-leading"
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            {t("appearance_reading.line_height")}
          </h3>
          <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-default/30 p-1">
            <button
              type="button"
              aria-label={t("entry.decrease_line_height")}
              disabled={atMinLineHeight}
              onClick={() => stepLineHeight(-1)}
              className="flex size-11 items-center justify-center rounded-xl text-foreground active:bg-item-hover disabled:opacity-35"
            >
              <Minus className="size-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {entryLineHeight.toFixed(1)}
            </span>
            <button
              type="button"
              aria-label={t("entry.increase_line_height")}
              disabled={atMaxLineHeight}
              onClick={() => stepLineHeight(1)}
              className="flex size-11 items-center justify-center rounded-xl text-foreground active:bg-item-hover disabled:opacity-35"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </section>

        <section aria-labelledby="mobile-reading-theme">
          <h3
            id="mobile-reading-theme"
            className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            {t("theme.label")}
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((value) => (
              <ChoiceButton
                key={value}
                active={theme === value}
                onClick={() => setTheme(value)}
              >
                {t(`theme.${value}`)}
              </ChoiceButton>
            ))}
          </div>
        </section>

        <section aria-labelledby="mobile-reading-preview">
          <h3
            id="mobile-reading-preview"
            className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
          >
            <Type className="size-3.5" />
            {t("entry.reading_preview")}
          </h3>
          <div className="rounded-2xl border border-border/60 bg-surface/60 px-4 py-3">
            <p
              className="text-foreground"
              style={{
                fontFamily: fontStack,
                fontSize: `${entryFontSize}px`,
                lineHeight: entryLineHeight,
              }}
            >
              {t("entry.reading_preview_text")}
            </p>
          </div>
        </section>
      </div>
    </MobileActionSheet>
  );
}
