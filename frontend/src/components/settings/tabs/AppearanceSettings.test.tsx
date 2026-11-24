import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setFetchReadableForView = vi.fn();
const setExpandLongForView = vi.fn();
const setReduceMotion = vi.fn();
const setTimelineGranularityForView = vi.fn();
const setTimelineCollapseForView = vi.fn();
const setTimelineTimeBasisForView = vi.fn();
const setEntryFontSize = vi.fn();
const setEntryLineHeight = vi.fn();

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
 * 2026-10-09 改法 A：按视图「滚动标已读」合并成一行四档，
 * 读写都走 useScrollReadSetting 的 perViewChoice / setPerViewChoice（不再是两个 useUISettingActions 的 setter）。
 */
const scrollReadState = vi.hoisted(() => ({
  mode: "perView" as "off" | "on" | "perView",
  perViewChoice: vi.fn(() => "inherit" as const),
  setPerViewChoice: vi.fn(),
}));

/** 单测可临时改写某个 UI 设置键（用于模拟「当前正用着某实验布局」） */
const uiOverride = vi.hoisted(() => ({
  articleLayout: undefined as unknown,
  pictureLayout: undefined as unknown,
  experimentalFeaturesEnabled: undefined as unknown,
  experimentalArticleHover: undefined as unknown,
  experimentalPictureHover: undefined as unknown,
  experimentalPictureWall: undefined as unknown,
}));

vi.mock("@/hooks/useScrollReadSetting", () => ({
  useScrollReadSetting: () => ({
    mode: scrollReadState.mode,
    resolveFor: () => true,
    globalOn: true,
    perViewChoice: scrollReadState.perViewChoice,
    setPerViewChoice: scrollReadState.setPerViewChoice,
    overrideCount: 0,
    anyViewEnabled: true,
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
    timelineTimeBasisByView: {
      article: "published",
      picture: "published",
      notification: "published",
      social: "published",
    },
    cardImageSize: "small",
    cardPreviewLines: 2,
    entryFontFamily: "system",
    entryFontSize: 16,
    entryLineHeight: 1.7,
    reduceMotion: false,
    articleLayout: "list",
    articlePushDirection: "right",
    articleCoverList: false,
    pictureLayout: "grid",
    gridStyle: "masonry",
    hoverRowHeight: "compact",
    hoverImageSize: "small",
    notificationBodyOnHover: false,
    experimentalFeaturesEnabled: false,
    experimentalPictureHover: false,
    experimentalPictureWall: false,
    experimentalArticleHover: false,
    splitterVisibleByView: {
      article: true,
      picture: true,
      notification: true,
      social: true,
    },
  };
  return {
    ...actual,
    useUISettingKey: (key: string) =>
      uiOverride[key as keyof typeof uiOverride] ?? values[key],
    useUISettingActions: () => ({
      setCardImageSize: vi.fn(),
      setCardPreviewLines: vi.fn(),
      setEntryFont: vi.fn(),
      setEntryFontSize,
      setEntryLineHeight,
      setFetchReadableForView,
      setExpandLongForView,
      setReduceMotion,
      setArticleLayout: vi.fn(),
      setPictureLayout: vi.fn(),
      setArticlePushDirection: vi.fn(),
      setArticleCoverList: vi.fn(),
      setTimelineGranularityForView,
      setTimelineCollapseForView,
      setTimelineTimeBasisForView,
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
    scrollReadState.perViewChoice.mockClear();
    scrollReadState.setPerViewChoice.mockClear();
    setTimelineGranularityForView.mockClear();
    setTimelineCollapseForView.mockClear();
    setTimelineTimeBasisForView.mockClear();
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

  it("正文字号 / 行高改为数字步进器（不再是固定几档），带范围提示", () => {
    render(<AppearanceSettings />);

    const sizeRow = rowOf("appearance_reading.font_size");
    // 提示文案在，且控件不再是 SegmentedControl（mock 会渲染 data-value）
    expect(
      within(sizeRow).getByText("appearance_reading.font_size_hint"),
    ).not.toBeNull();
    expect(sizeRow.querySelector("[data-value]")).toBeNull();
    const sizeInput = sizeRow.querySelector("input");
    expect(sizeInput).not.toBeNull();
    expect(sizeInput?.value).toBe("16");

    const lhRow = rowOf("appearance_reading.line_height");
    expect(
      within(lhRow).getByText("appearance_reading.line_height_hint"),
    ).not.toBeNull();
    expect(lhRow.querySelector("[data-value]")).toBeNull();
    const lhInput = lhRow.querySelector("input");
    expect(lhInput).not.toBeNull();
    // entryLineHeight=1.7，formatOptions 保留一位小数
    expect(lhInput?.value).toBe("1.7");
  });

  it("「列表图片」「摘要行数」挪进文章视图专属块（卡片分组不再出现，各只剩一处）", () => {
    render(<AppearanceSettings />);

    expect(screen.getAllByText("appearance_reading.card_image")).toHaveLength(1);
    expect(screen.getAllByText("appearance_reading.preview_lines")).toHaveLength(1);

    // 四个视图各一组「显示分界限」：文章那组（index 0）里应同时含 article_layout 与挪来的两项
    const articleViewRow = rowOf("appearance_view.show_splitter", 0);
    const articleViewBlock = articleViewRow.parentElement as HTMLElement;
    expect(
      within(articleViewBlock).queryByText("appearance_view.article_layout"),
    ).not.toBeNull();
    expect(
      within(articleViewBlock).queryByText("appearance_reading.card_image"),
    ).not.toBeNull();
    expect(
      within(articleViewBlock).queryByText("appearance_reading.preview_lines"),
    ).not.toBeNull();

    // 图片视图那组不该再出现这两项
    const pictureViewRow = rowOf("appearance_view.show_splitter", 1);
    const pictureViewBlock = pictureViewRow.parentElement as HTMLElement;
    expect(
      within(pictureViewBlock).queryByText("appearance_reading.card_image"),
    ).toBeNull();
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

  /**
   * 26-2：通知视图时间线的时间基准 —— 紧挨「时间粒度」，两档：发布时间（默认 = 现状）/
   * 抓取时间（本机抓回 = 刷新批次）。
   */
  it("通知视图有「时间基准」两档，默认发布时间", () => {
    render(<AppearanceSettings />);

    expect(screen.getAllByText("appearance_view.timeline_time_basis")).toHaveLength(1);
    const row = rowOf("appearance_view.timeline_time_basis");
    // 两档都在，默认选中「发布时间」
    expect(row.querySelector("[data-value]")?.getAttribute("data-value")).toBe(
      "published",
    );
    expect(within(row).getByText("published")).not.toBeNull();
    expect(within(row).getByText("fetched")).not.toBeNull();

    fireEvent.click(within(row).getByText("fetched"));
    expect(setTimelineTimeBasisForView).toHaveBeenCalledWith(
      "notification",
      "fetched",
    );
  });

  it("「长贴自动展开」在社交与通知视图出现（文章/图片视图不显示），默认关", () => {
    render(<AppearanceSettings />);

    // 社交 + 通知各一行，文章/图片没有（视图顺序 article/picture/notification/social → 通知在前）
    expect(screen.getAllByText("appearance_view.expand_long")).toHaveLength(2);

    const row = rowOf("appearance_view.expand_long", 0);
    expect(row.querySelector("[data-value]")?.getAttribute("data-value")).toBe(
      "off",
    );
    fireEvent.click(within(row).getByText("on"));

    expect(setExpandLongForView).toHaveBeenCalledWith("notification", true);
  });

  it("粒度与折叠行数只出现在通知视图（其余视图不显示）", () => {
    render(<AppearanceSettings />);

    // 每个视图一组「显示分界限」，通知那组里才有这三行
    expect(screen.getAllByText("appearance_view.show_splitter")).toHaveLength(4);
    expect(screen.getAllByText("appearance_view.timeline_granularity")).toHaveLength(1);
    expect(screen.getAllByText("appearance_view.timeline_collapse")).toHaveLength(1);
    expect(screen.getAllByText("appearance_view.timeline_time_basis")).toHaveLength(1);
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

  it("按视图「滚动标已读」一行四档，选「滚出顶部」写的是 perViewChoice", () => {
    render(<AppearanceSettings />);

    // 一行四档：跟随通用 / 点开才标已读 / 滚出顶部 / 看到即已读
    // （SegmentedControl 在这个测试里被 mock 成渲染 option.value，所以断言的是四档取值）
    const firstRow = rowOf("appearance_view.scroll_read");
    for (const optionValue of ["inherit", "clickOnly", "scrollPast", "onVisible"]) {
      expect(within(firstRow).getAllByText(optionValue).length).toBeGreaterThan(0);
    }

    fireEvent.click(within(firstRow).getByText("scrollPast"));
    expect(scrollReadState.setPerViewChoice).toHaveBeenCalledWith(
      "article",
      "scrollPast",
    );
  });


  it("实验布局批：实验关闭时，文章布局只余常规两档（传统三栏 / Inoreader列表）、图片选择器只余网格", () => {
    render(<AppearanceSettings />);

    const articleRow = rowOf("appearance_view.article_layout");
    expect(within(articleRow).getByText("list")).toBeTruthy();
    expect(within(articleRow).getByText("inoreader")).toBeTruthy();
    expect(within(articleRow).queryByText("rows")).toBeNull();
    expect(within(articleRow).queryByText("hover")).toBeNull();

    const pictureRow = rowOf("appearance_view.picture_layout");
    expect(within(pictureRow).getByText("grid")).toBeTruthy();
    expect(within(pictureRow).queryByText("hover")).toBeNull();
    expect(within(pictureRow).queryByText("wall")).toBeNull();
  });

  it("M1 回归：实验关闭时，即使当前正用着 hover/wall，选择器也不泄漏这两个实验入口", () => {
    uiOverride.articleLayout = "hover";
    uiOverride.pictureLayout = "wall";
    try {
      render(<AppearanceSettings />);

      const articleRow = rowOf("appearance_view.article_layout");
      expect(within(articleRow).queryByText("hover")).toBeNull();
      // 当前正用着已停用的实验布局时，给出解释性提示（不再让分段控件「无高亮」且无说明）
      expect(
        within(articleRow).getByText("appearance_view.experimental_disabled_hint"),
      ).toBeTruthy();

      const pictureRow = rowOf("appearance_view.picture_layout");
      expect(within(pictureRow).queryByText("hover")).toBeNull();
      expect(within(pictureRow).queryByText("wall")).toBeNull();
      expect(
        within(pictureRow).getByText("appearance_view.experimental_disabled_hint"),
      ).toBeTruthy();
    } finally {
      uiOverride.articleLayout = undefined;
      uiOverride.pictureLayout = undefined;
    }
  });

  it("实验布局批（正向）：总开关与对应子项都打开时，选择器出现 hover/wall 入口", () => {
    uiOverride.experimentalFeaturesEnabled = true;
    uiOverride.experimentalArticleHover = true;
    uiOverride.experimentalPictureHover = true;
    uiOverride.experimentalPictureWall = true;
    try {
      render(<AppearanceSettings />);

      const articleRow = rowOf("appearance_view.article_layout");
      expect(within(articleRow).getByText("hover")).toBeTruthy();

      const pictureRow = rowOf("appearance_view.picture_layout");
      expect(within(pictureRow).getByText("hover")).toBeTruthy();
      expect(within(pictureRow).getByText("wall")).toBeTruthy();
    } finally {
      uiOverride.experimentalFeaturesEnabled = undefined;
      uiOverride.experimentalArticleHover = undefined;
      uiOverride.experimentalPictureHover = undefined;
      uiOverride.experimentalPictureWall = undefined;
    }
  });

  it("改法 A：总开关是「关」时按视图那一行照样在（不再被门控）", () => {
    scrollReadState.mode = "off";
    render(<AppearanceSettings />);

    // 旧版要先去通用选「按视图单独设」才出现，现在四个视图的行常显
    expect(screen.getAllByText("appearance_view.scroll_read")).toHaveLength(4);
  });
});
