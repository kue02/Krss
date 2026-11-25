/**
 * 正文字体预设 —— 只列系统自带字体族，避免联网拉 Google Fonts
 * （Nextflux 会按需下载字体；这里刻意保持「零外部请求」）
 */

export interface ReadingFontOption {
  /** 存进 UI 设置的值；空串 = 跟随主题默认字体 */
  value: string;
  /** i18n key 后缀，文案在 locales 的 reading_font.* */
  labelKey: string;
  stack: string;
}

export const readingFonts: ReadingFontOption[] = [
  {
    value: "",
    labelKey: "theme_default",
    stack: "",
  },
  {
    value: "sans",
    labelKey: "sans",
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  {
    value: "serif",
    labelKey: "serif",
    // 长文阅读衬线栈：西文优先 Charter / Iowan / Palatino（可读性与书卷气好），
    // 中文落到宋体系（macOS Songti SC / STSong，跨平台 Noto Serif CJK / 思源宋体）。
    // 全部系统字体，零外部请求。
    stack:
      'Charter, "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif',
  },
  {
    value: "mono",
    labelKey: "mono",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
];

export function resolveReadingFontStack(value: string): string | undefined {
  const option = readingFonts.find((item) => item.value === value);
  return option?.stack ? option.stack : undefined;
}
