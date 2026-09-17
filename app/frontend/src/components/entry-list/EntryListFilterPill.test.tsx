import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryListFilterPill } from "./EntryListFilterPill";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("EntryListFilterPill", () => {
  afterEach(cleanup);

  it("按「星标 / 未读 / 已静音 / 全部」四态渲染", () => {
    render(<EntryListFilterPill value="all" onChange={vi.fn()} />);

    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual([
      "entry_filter.starred",
      "entry_filter.unread",
      "entry_filter.muted",
      "entry_filter.all",
    ]);
  });

  it("选中态只落在一个选项上，已静音可被选中", () => {
    render(<EntryListFilterPill value="muted" onChange={vi.fn()} />);

    expect(
      screen.getByText("entry_filter.muted").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByText("entry_filter.all").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("点击「已静音」回传 muted", () => {
    const onChange = vi.fn();
    render(<EntryListFilterPill value="all" onChange={onChange} />);

    fireEvent.click(screen.getByText("entry_filter.muted"));

    expect(onChange).toHaveBeenCalledWith("muted");
  });
});
