import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Label,
} from "@heroui/react";
import { useTheme } from "@/hooks/useTheme";
import { useUISettingActions, useUISettingKey } from "@/hooks/useUISettings";

/**
 * 主题色（用户 11-13：点名用 HeroUI 的 ColorPicker）。
 *
 * 取值语义：`null` = 跟随当前主题自带的强调色（默认）；选了颜色就写进 `settings.accentColor`，
 * 由 `applyAccentColorToDocument()` 落到 `<html>` 的内联 `--accent` 上（明暗主题都跟着走）。
 * 触发器显示当前实际生效的强调色，所以「跟随主题」时看到的就是主题自带的那个色。
 */
const PRESETS = ["#0485f7", "#8b5cf6", "#f43f5e", "#f59e0b", "#10b981"];

export function AccentColorPicker() {
  const { t } = useTranslation();
  const accentColor = useUISettingKey("accentColor");
  const { setAccentColor } = useUISettingActions();
  // 主题一变（明/暗、换配色）默认强调色也变，触发器要跟着重算
  const { theme, lightTheme, darkTheme } = useTheme();

  const themeAccent = useMemo(() => {
    if (typeof window === "undefined") return "#0485f7";
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    return value || "#0485f7";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, lightTheme, darkTheme, accentColor]);

  /**
   * 12-4（用户：选颜色时组件会抖动）：受控值**不能**从 DOM 里的 `--accent` 反推。
   *
   * 原来的链路是：拖动 → onChange → 写设置 → `applyAccentColorToDocument()` 改 `<html>` 的
   * `--accent` → memo 依赖 accentColor 重算 → 从 DOM 读回的是**另一种颜色表示**（oklch / 精度不同）
   * → 重新塞回 ColorPicker 的 value → 拖动的滑块被拉回去（看起来就是抖）。
   *
   * 现在拖动期间用自己的本地状态，不再读 DOM；只有「跟随主题」时才回落到主题色。
   */
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? accentColor ?? themeAccent;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ColorPicker
        value={current}
        onChange={(color) => {
          const hex = color.toString("hex");
          setDraft(hex);
          setAccentColor(hex);
        }}
      >
        <ColorPicker.Trigger>
          <ColorSwatch className="size-7 rounded-full border border-border/60" />
          <Label className="text-xs text-muted-foreground">
            {accentColor ? accentColor : t("theme.accent_following")}
          </Label>
        </ColorPicker.Trigger>
        <ColorPicker.Popover>
          <div className="w-56 space-y-3 p-3">
            <ColorArea
              colorSpace="hsb"
              xChannel="saturation"
              yChannel="brightness"
              className="w-full"
            >
              <ColorArea.Thumb />
            </ColorArea>
            <ColorSlider channel="hue" colorSpace="hsb">
              <ColorSlider.Track>
                <ColorSlider.Thumb />
              </ColorSlider.Track>
            </ColorSlider>
            <div className="flex items-center gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  title={preset}
                  aria-label={preset}
                  onClick={() => {
                    setDraft(preset);
                    setAccentColor(preset);
                  }}
                  className="size-5 rounded-full border border-border/60"
                  style={{ backgroundColor: preset }}
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onPress={() => {
                  setDraft(null);
                  setAccentColor(null);
                }}
              >
                {t("theme.accent_follow")}
              </Button>
            </div>
          </div>
        </ColorPicker.Popover>
      </ColorPicker>
    </div>
  );
}
