import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setFetchReadableForView = vi.fn();
const setExpandLongForView = vi.fn();
const setReduceMotion = vi.fn();
const setScrollReadForView = vi.fn();
const setScrollReadTimingForView = vi.fn();
const setTimelineGranularityForView = vi.fn();
const setTimelineCollapseForView = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@/api", () => ({
  updateAppearanceSettings: vi.fn(),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light",
    lightTheme: "light",
    darkTheme: "dark",
    setTheme: vi.fn(),
    setLightTheme: vi.fn(),
    setDarkTheme: vi.fn(),
    fontSize: "medium",
    setFontSize: vi.fn(),
  }),
  themes: {
    light: [{ id: "light", label: "Light" }],
    dark: [{ id: "dark", label: "Dark" }],
  },
}));

vi.mock("@/hooks/useAppearanceSettings", () => ({
  useAppearanceSettings: () => ({ data: undefined, isLoading: false }),
}));

/**
 * 「滚动标已读」总开关形态：默认按 perView 跑（这样按视图覆盖的行可见），
 * 需要测 off 联动时改 scrollReadState.mode。
 */
const scrollReadState = vi.hoisted(() => ({
  mode: "perView" as "off" | "on" | "perView",
}));

vi.mock("@/hooks/useScrollReadSetting", () => ({
  useScrollReadSetting: () => ({
    mode: scrollReadState.mode,
    resolveFor: () => true,
    globalOn: true,
  }),
}));

vi.mock("@/hooks/useUISettings", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/useUISettings")>(
      "@/hooks/useUISettings",
    );
  const values: Record<string, unknown> = {
    viewModeByView: {
      article: "card",
      picture: "card",
      notification: "card",
    },
    fetchReadableByView: {
      article: false,
      picture: false,
      notification: false,
    },
    expandLongByView: {
      article: false,
      picture: false,
      notification: false,
      social: false,
    },
    scrollReadByView: {
      article: "inherit",
      picture: "inherit",
      notification: "inherit",
    },
    scrollReadMode: "perView",
    scrollReadTimingByView: {
      article: "scrollPast",
      picture: "scrollPast",
      notification: "scrollPast",
      social: "scrollPast",
    },
    timelineGranularityByView: {
      article: "hour",
      picture: "hour",
      notification: "hour",
      social: "hour",
    },
    timelineCollapseByView: {
      article: "2",
      picture: "2",
      notification: "2",
      social: "2",
    },
    cardImageSize: "small",
    cardPreviewLines: 2,
    entryFontFamily: "system",
    entryFontSize: 16,
    entryLineHeight: 1.7,
    reduceMotion: false,
    splitterVisibleByView: {
      article: true,
      picture: true,
      notification: true,
      social: true,
    },
  };
  return {
    ...actual,
    useUISettingKey: (key: string) => values[key],
    useUISettingActions: () => ({
      setCardImageSize: vi.fn(),
      setCardPreviewLines: vi.fn(),
      setEntryFont: vi.fn(),
      setFetchReadableForView,
      setExpandLongForView,
      setReduceMotion,
      setScrollReadForView,
      setScrollReadTimingForView,
      setTimelineGranularityForView,
      setTimelineCollapseForView,
    }),
  };
});

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    value,
    onValueChange,
    options,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <div data-value={value}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onValueChange(option.value)}
        >
          {option.value}
        </button>
      ))}
    </div>
  ),
}));

import { AppearanceSettings } from "@/components/settings/tabs/AppearanceSettings";

/** 取某一行的容器（SettingRow = 标签 div + 控件 div，共用一个父节点） */
function rowOf(labelKey: string, index = 0): HTMLElement {
  const label = screen.getAllByText(labelKey)[index];
  if (!label?.parentElement) throw new Error(`row not found: ${labelKey}`);
  return label.parentElement;
}

describe("AppearanceSettings 按视图设置", () => {
  beforeEach(() => {
    setFetchReadableForView.mockClear();
    setExpandLongForView.mockClear();
    setReduceMotion.mockClear();
    setScrollReadForView.mockClear();
    setScrollReadTimingForView.mockClear();
    setTimelineGranularityForView.mockClear();
    setTimelineCollapseForView.mockClear();
    scrollReadState.mode = "perView";
  });

  it("四个内容类型（含社交媒体）各有一组按视图设置", () => {
    render(<AppearanceSettings />);

    const scrollRows = screen.getAllByText("appearance_view.scroll_read");
    expect(scrollRows).toHaveLength(4);
  });

  it("「缺全文时自动抓取」只在文章视图出现（社交链接抓回的是登录墙），默认关", () => {
    render(<AppearanceSettings />);

    const rows = screen.getAllByText("appearance_view.fetch_readable");
    expect(rows).toHaveLength(1);

    const row = rowOf("appearance_view.fetch_readable");
    expect(within(row).queryByText("off")).not.toBeNull();
    fireEvent.click(within(row).getByText("on"));

    expect(setFetchReadableForView).toHaveBeenCalledWith("article", true);
  });

  it("「减少动态效果」默认关，可打开", () => {
    render(<AppearanceSettings />);

    const row = rowOf("appearance_reading.reduce_motion");
    expect(within(row).queryByText("off")).not.toBeNull();
    fireEvent.click(within(row).getByText("on"));

    expect(setReduceMotion).toHaveBeenCalledWith(true);
  });

  /**
   * 第十五批（15-5）：通知视图 = 时间线。设置里只有**粒度**与**折叠行数**两项 ——
   * 「通知视图只有时间线这一种模式」（用户拍板），所以**没有**「切回列表 / 形态」这一类开关。
   */
  it("通知视图有「时间粒度」四档，默认每小时", () => {
    render(<AppearanceSettings />);

    expect(screen.getAllByText("appearance_view.timeline_granularity")).toHaveLength(1);
    const row = rowOf("appearance_view.timeline_granularity");
    // 四档都在，默认选中「每小时」
    expect(row.querySelector("[data-value]")?.getAttribute("data-value")).toBe("hour");
    expect(within(row).getByText("minute")).not.toBeNull();
    expect(within(row).getByText("quarter")).not.toBeNull();
    expect(within(row).getByText("hour")).not.toBeNull();
    expect(within(row).getByText("day")).not.toBeNull();

    fireEvent.click(within(row).getByText("day"));
    expect(setTimelineGranularityForView).toHaveBeenCalledWith("notification", "day");
  });

  it("通知视图有「折叠行数」四档，默认 2 行", () => {
    render(<AppearanceSettings />);

    const row = rowOf("appearance_view.timeline_collapse");
    expect(row.querySelector("[data-value]")?.getAttribute("data-value")).toBe("2");
    expect(within(row).getByText("full")).not.toBeNull();

    fireEvent.click(within(row).getByText("full"));
    expect(setTimelineCollapseForView).toHaveBeenCalledWith("notification", "full");
  });

  it("粒度与折叠行数只出现在通知视图（其余视图不显示）", () => {
    render(<AppearanceSettings />);

    // 每个视图一组「显示分界限」，通知那组里才有这两行
    expect(screen.getAllByText("appearance_view.show_splitter")).toHaveLength(4);
    expect(screen.getAllByText("appearance_view.timeline_granularity")).toHaveLength(1);
    expect(screen.getAllByText("appearance_view.timeline_collapse")).toHaveLength(1);
  });

  it("没有「切回列表 / 呈现方式」这类项（通知视图只有时间线一种形态）", () => {
    render(<AppearanceSettings />);

    // 设置里任何把通知视图切回卡片列表的开关都不该存在
    for (const key of [
      "appearance_view.view_mode",
      "appearance_view.timeline_mode",
      "appearance_view.timeline_enabled",
    ]) {
      expect(screen.queryAllByText(key)).toHaveLength(0);
    }
  });

  it("滚动标已读默认跟随通用", () => {
    render(<AppearanceSettings />);

    const rows = screen.getAllByText("appearance_view.scroll_read");
    expect(rows).toHaveLength(4);

    const firstRow = rowOf("appearance_view.scroll_read");
    fireEvent.click(within(firstRow).getByText("on"));
    expect(setScrollReadForView).toHaveBeenCalledWith("article", "on");
  });

  it("总开关关掉「滚动标已读」时，「已读判定」整行置灰并说明不生效", () => {
    scrollReadState.mode = "off";
    render(<AppearanceSettings />);

    // 按视图的「滚动标已读」开关只有在 perView 模式才出现
    expect(screen.queryAllByText("appearance_view.scroll_read")).toHaveLength(0);

    // 判定行还在，但标记为不可用 + 原因
    const row = rowOf("appearance_view.read_timing");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getAllByText("appearance_view.read_timing_disabled").length,
    ).toBeGreaterThan(0);

    // 注：jsdom 不做命中测试，「点不动」是 pointer-events:none 的真实浏览器行为，
    // 单元层只能断言 aria-disabled 与原因文案；「点不动」在 :5173 用真实鼠标验。
  });
});
