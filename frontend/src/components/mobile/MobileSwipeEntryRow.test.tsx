import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("touchmove 过程中内容层已随位移变化（跟手，不是松手才变）", () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    act(() => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 150, 100));
    });

    // 松手前 inline transform 就已跟手变化到 -70px
    expect(content.style.transform).toBe("translateX(-70px)");
  });

  it("松手未过阈值时回弹到 0", () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    act(() => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 205, 100)); // 只拖了 15px
      row.dispatchEvent(touch("touchend", 205, 100));
    });

    expect(content.style.transform).toBe("translateX(0px)");
    expect(screen.queryByRole("button", { name: "entry.mark_read" })).toBeNull();
  });

  it("已展开时向右拖可收起", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    swipeLeft(row);
    await screen.findByRole("button", { name: "entry.mark_read" });
    expect(content.style.transform).toBe("translateX(-132px)");

    act(() => {
      row.dispatchEvent(touch("touchstart", 100, 100));
      row.dispatchEvent(touch("touchmove", 220, 100)); // 右拖 120px
      row.dispatchEvent(touch("touchend", 220, 100));
    });

    expect(content.style.transform).toBe("translateX(0px)");
    expect(screen.queryByRole("button", { name: "entry.mark_read" })).toBeNull();
  });

  it("使用旧版动作条与按钮样式", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;

    swipeLeft(row);
    await screen.findByRole("button", { name: "entry.mark_read" });

    const actions = container.querySelector(
      "[data-swipe-actions]",
    ) as HTMLElement;
    expect(actions.className).toContain("bg-item-hover");
    expect(actions.className).toContain("rounded-[10px]");
    expect(actions.className).toContain("border-border/60");

    const span = actions.querySelector("span") as HTMLElement;
    expect(span.className).toContain("size-7");
  });
});
