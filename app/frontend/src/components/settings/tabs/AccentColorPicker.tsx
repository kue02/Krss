import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Label,
  parseColor,
} from "@heroui/react";
import { Shuffle } from "lucide-react";
import type { Color } from "react-aria-components";
import { useUISettingActions, useUISettingKey } from "@/hooks/useUISettings";

/**
 * 主题色（用户 11-13：点名用 HeroUI 的 ColorPicker；20-1 按 HeroUI 官方取色面板重做）。
 *
 * 取值语义：`null` = 跟随当前主题自带的强调色（默认）；选了颜色就写进 `settings.accentColor`，
 * 由 `applyAccentColorToDocument()` 落到 `<html>` 的内联 `--accent` 上（明暗主题都跟着走）。
 *
 * **面板结构照 HeroUI 官方那套**（顶部预设色块行 → 取色区 → 色相条 + 右侧图标按钮 →
 * 底部带色块前缀的 hex 输入框），全部用组件库自己的件：
 * `ColorSwatchPicker`（+ Item/Swatch/Indicator，悬停放大/选中内缩都是组件自带动效）、
 * `ColorArea` / `ColorSlider` / `ColorField`（Group + Prefix + Input）。
 * 之前那版在手搓的 `div.w-56` 里拼了 5 个 `<button>` 当预设色块 —— 动效与组件库不一致，
 * 已整块删掉（用户 2026-09-18 指出）。
 */
const PRESETS = [
  "#0485f7",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
];

/** 拿不到强调色时的兜底（HeroUI 默认那支蓝） */
const FALLBACK_ACCENT = "#0485f7";

/**
 * 把 CSS 颜色串解析成 hex。
 *
 * 主题自带的强调色是 **oklch**（实测 `--accent` = `oklch(0.6204 0.195 253.83)`），
 * 而 RAC 的 `parseColor` 吃不了 oklch —— 直接把它塞给 ColorPicker，整套会**静默退化成黑色**
 * （实测：跟随主题时触发器色块、取色区、hex 输入框全是黑的、输入框写着 `#000000`）。
 * 所以交给浏览器自己解析：写进 1×1 canvas 取像素，任何 CSS 颜色格式都能拿到真实 RGB。
 */
function resolveAccentHex(cssColor: string): string {
  if (typeof document === "undefined") return FALLBACK_ACCENT;
  const value = cssColor.trim();
  if (!value) return FALLBACK_ACCENT;
  // 用户自选的颜色本来就是 hex，直接透传（也避免多走一次 canvas）
  if (value.startsWith("#")) return value;
  try {
    if (typeof CSS !== "undefined" && !CSS.supports("color", value)) {
      return FALLBACK_ACCENT;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return FALLBACK_ACCENT;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    const toHex = (channel: number | undefined) =>
      (channel ?? 0).toString(16).padStart(2, "0");
    return `#${toHex(data[0])}${toHex(data[1])}${toHex(data[2])}`;
  } catch {
    return FALLBACK_ACCENT;
  }
}

/** 当前生效的强调色（可能是 oklch / rgb / hex，交给 resolveAccentHex 归一） */
function readAccentVar(): string {
  if (typeof window === "undefined") return FALLBACK_ACCENT;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return resolveAccentHex(value || FALLBACK_ACCENT);
}

export function AccentColorPicker() {
  const { t } = useTranslation();
  const accentColor = useUISettingKey("accentColor");
  const { setAccentColor } = useUISettingActions();

  /**
   * 「跟随主题」时的强调色要从 `<html>` 上的 `--accent` 读 —— 但**不能在这一 render 里读**：
   * 写 `--accent` 的是 App 的 effect（`applyAccentColorToDocument`），而 effect 是**子先父后**，
   * 本组件作为子组件先跑，读到的还是上一轮的值 ⇒ 点「跟随主题」后面板停在旧颜色上
   * （实测：#EC4876 不更新，只有刷新页面才对）。
   *
   * 做法：盯住 `<html>` 的 style / class / data-theme —— 值真落地了（或主题换了）才重读。
   * 比「effect 里挂一次 rAF」稳：rAF 与 React 刷 effect 的先后没有保证（实测拖完色相条再点
   * 「跟随主题」时偶发读到旧值）。
   */
  const [themeAccent, setThemeAccent] = useState<string>(() => readAccentVar());
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setThemeAccent(readAccentVar());
    sync();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  /**
   * 抖动根因（12-4 没修干净、20-1 重新定位）：受控值**不能**回灌「另一种颜色表示」。
   *
   * 老写法是 `onChange` 里 `color.toString("hex")` 存下来再喂回 `ColorPicker` 的 `value`，
   * 而 hex 是 8 位精度、拖到一半的色相/饱和度会被rounding 掉一点点 ⇒ 组件拿到的值
   * 与自己内部那一步不一致 ⇒ 滑块/取色点被拽回去（看起来就是「抖」）。
   * 现在**存 RAC 的 `Color` 对象本身**，回灌是精确值；写设置里才转 hex。
   * 另外拖动期间不读 DOM 的 `--accent`（那也是另一种颜色表示）。
   */
  const [draft, setDraft] = useState<Color | null>(null);
  const current: string | Color = draft ?? accentColor ?? themeAccent;

  const applyColor = (color: Color) => {
    setDraft(color);
    setAccentColor(color.toString("hex"));
  };

  /** 随机配色（对齐 HeroUI 官方面板右侧那颗图标按钮） */
  const handleShuffle = () => {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 55 + Math.floor(Math.random() * 35);
    const lightness = 45 + Math.floor(Math.random() * 15);
    applyColor(parseColor(`hsl(${hue}, ${saturation}%, ${lightness}%)`));
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ColorPicker value={current} onChange={applyColor}>
        <ColorPicker.Trigger>
          <ColorSwatch className="size-7 rounded-full border border-border/60" />
          <Label className="text-xs text-muted-foreground">
            {accentColor ? accentColor : t("theme.accent_following")}
          </Label>
        </ColorPicker.Trigger>
        <ColorPicker.Popover>
          <ColorSwatchPicker aria-label={t("theme.accent_color")} size="xs" className="justify-center">
            {PRESETS.map((preset) => (
              <ColorSwatchPicker.Item key={preset} color={preset} aria-label={preset}>
                <ColorSwatchPicker.Swatch />
                <ColorSwatchPicker.Indicator />
              </ColorSwatchPicker.Item>
            ))}
          </ColorSwatchPicker>
          <ColorArea
            aria-label={t("theme.accent_area")}
            colorSpace="hsb"
            xChannel="saturation"
            yChannel="brightness"
            className="max-w-full"
          >
            <ColorArea.Thumb />
          </ColorArea>
          <div className="flex w-full items-center gap-2">
            <ColorSlider
              aria-label={t("theme.accent_hue")}
              channel="hue"
              colorSpace="hsb"
              className="min-w-0 flex-1"
            >
              <ColorSlider.Track>
                <ColorSlider.Thumb />
              </ColorSlider.Track>
            </ColorSlider>
            <Button
              isIconOnly
              size="sm"
              variant="tertiary"
              className="size-8 min-w-8 shrink-0 rounded-full"
              aria-label={t("theme.accent_shuffle")}
              onPress={handleShuffle}
            >
              <Shuffle className="size-4" />
            </Button>
          </div>
          <ColorField aria-label={t("theme.accent_hex")} className="w-full">
            <ColorField.Group variant="secondary" fullWidth>
              <ColorField.Prefix>
                <ColorSwatch className="size-5 rounded-full" />
              </ColorField.Prefix>
              <ColorField.Input />
            </ColorField.Group>
          </ColorField>
          <Button
            size="sm"
            variant="ghost"
            fullWidth
            isDisabled={!accentColor}
            onPress={() => {
              setDraft(null);
              setAccentColor(null);
            }}
          >
            {t("theme.accent_follow")}
          </Button>
        </ColorPicker.Popover>
      </ColorPicker>
    </div>
  );
}
