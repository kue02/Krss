import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSwipeEntryRow } from "./MobileSwipeEntryRow";
import type { Entry } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { markAsRead, markAsStarred } = vi.hoisted(() => ({
  markAsRead: vi.fn(),
  markAsStarred: vi.fn(),
}));

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: markAsRead }),
  useMarkAsStarred: () => ({ mutate: markAsStarred }),
}));

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    feedId: "f1",
    title: "entry",
    url: "https://example.com/e1",
    content: "content",
    read: false,
    starred: false,
    muted: false,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    ...overrides,
  } as unknown as Entry;
}

function touch(
  type: "touchstart" | "touchmove" | "touchend",
  x: number,
  y: number,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
  });
  return event;
}

/** 在行元素上模拟一次左滑（超过 threshold=30 且水平位移占优） */
function swipeLeft(row: HTMLElement) {
  row.dispatchEvent(touch("touchstart", 220, 100));
  row.dispatchEvent(touch("touchmove", 210, 100));
  row.dispatchEvent(touch("touchmove", 150, 100));
  row.dispatchEvent(touch("touchend", 150, 100));
}

describe("MobileSwipeEntryRow", () => {
  beforeEach(() => {
    markAsRead.mockReset();
    markAsStarred.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("左滑后露出已读/星标两个动作，且默认不显示", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );

    // 收起时动作按钮在无障碍树外
    expect(screen.queryByRole("button", { name: "entry.mark_read" })).toBeNull();

    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    swipeLeft(row);

    expect(
      await screen.findByRole("button", { name: "entry.mark_read" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "entry.add_to_starred" }),
    ).toBeTruthy();
  });

  it("点「标为已读」调用 useMarkAsRead（read=true）", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    swipeLeft(container.querySelector("[data-swipe-row]") as HTMLElement);

    fireEvent.click(await screen.findByRole("button", { name: "entry.mark_read" }));

    expect(markAsRead).toHaveBeenCalledWith({ id: "e1", read: true });
    expect(markAsStarred).not.toHaveBeenCalled();
  });

  it("点「加入星标」调用 useMarkAsStarred（starred=true）", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    swipeLeft(container.querySelector("[data-swipe-row]") as HTMLElement);

    fireEvent.click(
      await screen.findByRole("button", { name: "entry.add_to_starred" }),
    );

    expect(markAsStarred).toHaveBeenCalledWith({ id: "e1", starred: true });
  });

  it("展开时点内容区只收起，不触发卡片自身的点击", async () => {
    const childClick = vi.fn();
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <button type="button" onClick={childClick}>
          卡片内容
        </button>
      </MobileSwipeEntryRow>,
    );
    swipeLeft(container.querySelector("[data-swipe-row]") as HTMLElement);
    await screen.findByRole("button", { name: "entry.mark_read" });

    fireEvent.click(screen.getByText("卡片内容"));

    expect(childClick).not.toHaveBeenCalled();
    // 收起后动作按钮又回到无障碍树外
    expect(screen.queryByRole("button", { name: "entry.mark_read" })).toBeNull();
  });
});
