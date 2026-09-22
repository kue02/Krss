import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryListFilterPill } from "./EntryListFilterPill";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("EntryListFilterPill", () => {
  afterEach(cleanup);

  // 「已静音」曾经是这里的一态，2026-09-17 用户要求移除（静音=不想看，
  // 不该占中栏高位入口），入口改到 设置 → 自动化，见 filter-view-store.mutedOnly。
  it("只按「星标 / 未读 / 全部」三态渲染", () => {
    render(<EntryListFilterPill value="all" onChange={vi.fn()} />);

    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual([
      "entry_filter.starred",
      "entry_filter.unread",
      "entry_filter.all",
    ]);
  });

  it("选中态只落在一个选项上", () => {
    render(<EntryListFilterPill value="unread" onChange={vi.fn()} />);

    expect(screen.getByText("entry_filter.unread").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("entry_filter.all").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("entry_filter.starred").getAttribute("aria-pressed")).toBe("false");
  });

  it("点击回传对应的筛选值", () => {
    const onChange = vi.fn();
    render(<EntryListFilterPill value="all" onChange={onChange} />);

    fireEvent.click(screen.getByText("entry_filter.starred"));

    expect(onChange).toHaveBeenCalledWith("starred");
  });
});
