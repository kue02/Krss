import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setFetchReadableForView = vi.fn();
const setExpandLongForView = vi.fn();
const setScrollReadForView = vi.fn();

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
    cardImageSize: "small",
    cardPreviewLines: 2,
    entryFontFamily: "system",
    entryFontSize: 16,
    entryLineHeight: 1.7,
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
      setScrollReadForView,
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
    setScrollReadForView.mockClear();
  });

  it("四个内容类型（含社交媒体）各有一组按视图设置", () => {
    render(<AppearanceSettings />);

    const scrollRows = screen.getAllByText("appearance_view.scroll_read");
    expect(scrollRows).toHaveLength(4);
  });

  it("「缺全文时自动抓取」只在社交媒体视图出现，默认关", () => {
    render(<AppearanceSettings />);

    const rows = screen.getAllByText("appearance_view.fetch_readable");
    expect(rows).toHaveLength(1);

    const row = rowOf("appearance_view.fetch_readable");
    expect(within(row).queryByText("off")).not.toBeNull();
    fireEvent.click(within(row).getByText("on"));

    expect(setFetchReadableForView).toHaveBeenCalledWith("social", true);
  });

  it("滚动标已读默认跟随通用", () => {
    render(<AppearanceSettings />);

    const rows = screen.getAllByText("appearance_view.scroll_read");
    expect(rows).toHaveLength(4);

    const firstRow = rowOf("appearance_view.scroll_read");
    fireEvent.click(within(firstRow).getByText("on"));
    expect(setScrollReadForView).toHaveBeenCalledWith("article", "on");
  });
});
