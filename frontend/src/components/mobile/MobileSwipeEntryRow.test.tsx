import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  x: number,
  y: number,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    value:
      type === "touchend" || type === "touchcancel"
        ? []
        : [{ clientX: x, clientY: y }],
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

/** 等一帧：拖动期间的 transform 由 rAF 合并写入，断言前需让出这一帧 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

  it("touchmove 过程中内容层已随位移变化（跟手，不是松手才变）", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    await act(async () => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 150, 100));
      await nextFrame();
    });

    // 松手前 inline transform 就已跟手变化到 -70px
    expect(content.style.transform).toBe("translateX(-70px)");
  });

  it("拖动期间内容层不因每帧 setState 重渲染（父级不受影响）", async () => {
    const childRender = vi.fn();
    function Child() {
      childRender();
      return <div>卡片内容</div>;
    }
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <Child />
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;
    childRender.mockClear();

    await act(async () => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 200, 100));
      row.dispatchEvent(touch("touchmove", 180, 100));
      row.dispatchEvent(touch("touchmove", 150, 100));
      await nextFrame();
    });

    // 整个拖动过程中子内容只随父级初始渲染一次，没有因逐帧位移重渲染
    expect(childRender).not.toHaveBeenCalled();
    expect(content.style.transform).toBe("translateX(-70px)");
  });

  it("拖动过程中父级重渲染不会把内容层的跟手 transform 重置", async () => {
    function Harness() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick((v) => v + 1)}>
            重渲染父级
          </button>
          <MobileSwipeEntryRow entry={makeEntry()}>
            <div>卡片内容</div>
          </MobileSwipeEntryRow>
        </div>
      );
    }
    const { container } = render(<Harness />);
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    await act(async () => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 150, 100));
      await nextFrame();
    });
    expect(content.style.transform).toBe("translateX(-70px)");

    // 父级重渲染（同一帧内再触发一次）后，跟手中的 transform 不能被 React 用 0 覆盖
    await act(async () => {
      fireEvent.click(screen.getByText("重渲染父级"));
      await nextFrame();
    });
    expect(content.style.transform).toBe("translateX(-70px)");
  });

  it("拖动中另一行触发 SWIPE_OPEN_EVENT 改变 open 时不覆盖跟手位移", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    // 先展开（open=true，位移 -132）
    swipeLeft(row);
    await screen.findByRole("button", { name: "entry.mark_read" });
    expect(content.style.transform).toBe("translateX(-132px)");

    // 展开状态下向右拖 40px：基准 -132 → -92px
    await act(async () => {
      row.dispatchEvent(touch("touchstart", 100, 100));
      row.dispatchEvent(touch("touchmove", 140, 100));
      await nextFrame();
    });
    expect(content.style.transform).toBe("translateX(-92px)");

    // 拖动中另一行打开 → 本行收到 SWIPE_OPEN_EVENT 被改 open=false（触发父级重渲染）
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("krss:mobile-swipe-open", { detail: "other-entry" }),
      );
      await nextFrame();
    });
    // open 变了，但当前手指位移不能被 React 覆盖
    expect(content.style.transform).toBe("translateX(-92px)");

    // 松手：位移 92px > 66px，按最终手势吸附展开
    await act(async () => {
      row.dispatchEvent(touch("touchend", 140, 100));
      await nextFrame();
    });
    expect(content.style.transform).toBe("translateX(-132px)");
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

  it("快速短距离左甩（位移不到 66px）也能展开", async () => {
    let clock = 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    await act(async () => {
      row.dispatchEvent(touch("touchstart", 200, 100));
      clock += 20;
      row.dispatchEvent(touch("touchmove", 180, 100)); // -1 px/ms
      clock += 40;
      row.dispatchEvent(touch("touchmove", 145, 100)); // 位移仅 -55px，速度 -0.875 px/ms
      clock += 10;
      row.dispatchEvent(touch("touchend", 145, 100));
      await nextFrame();
    });
    nowSpy.mockRestore();

    // 55px < 66px，单靠位移不会展开；靠快速左甩的速度判定展开
    expect(content.style.transform).toBe("translateX(-132px)");
    expect(
      await screen.findByRole("button", { name: "entry.mark_read" }),
    ).toBeTruthy();
  });

  it("已展开时快速短距离右甩也能收起（位移不到阈值、靠速度判定）", async () => {
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

    let clock = 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    await act(async () => {
      row.dispatchEvent(touch("touchstart", 100, 100));
      clock += 20;
      row.dispatchEvent(touch("touchmove", 120, 100)); // +1 px/ms
      clock += 20;
      row.dispatchEvent(touch("touchmove", 132, 100)); // 右移 32px，速度 +0.6 px/ms
      clock += 10;
      row.dispatchEvent(touch("touchend", 132, 100));
      await nextFrame();
    });
    nowSpy.mockRestore();

    // 基准 -132 + 32 = -100，abs(100) > 66 单靠位移会保持展开；靠快速右甩速度收起
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

  it("拖过 100px 后 touchcancel 不打开（按取消回弹到关闭）", async () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    const content = container.querySelector(
      "[data-swipe-content]",
    ) as HTMLElement;

    await act(async () => {
      row.dispatchEvent(touch("touchstart", 220, 100));
      row.dispatchEvent(touch("touchmove", 150, 100)); // 左拖 70px
      row.dispatchEvent(touch("touchmove", 110, 100)); // 左拖 110px
      await nextFrame();
    });
    expect(content.style.transform).toBe("translateX(-110px)");

    act(() => {
      row.dispatchEvent(touch("touchcancel", 110, 100));
    });

    // 取消不算展开：110px > 66px 也不打开，回到 0
    expect(content.style.transform).toBe("translateX(0px)");
    expect(screen.queryByRole("button", { name: "entry.mark_read" })).toBeNull();
  });

  it("已展开行 touchcancel 保持展开（回到手势前 open 状态）", async () => {
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
      row.dispatchEvent(touch("touchmove", 120, 100)); // 右拖 20px（基准 -132 → -112）
      row.dispatchEvent(touch("touchcancel", 120, 100));
    });

    // 取消回到手势前的展开状态
    expect(content.style.transform).toBe("translateX(-132px)");
    expect(
      screen.queryByRole("button", { name: "entry.mark_read" }),
    ).toBeTruthy();
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

  it("默认不加 content-visibility（普通行高不适合离屏估算）", () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()}>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    expect(row.className).not.toContain("content-visibility");
  });

  it("传 contentVisibility 时根节点加 content-visibility 与 600px 估算", () => {
    const { container } = render(
      <MobileSwipeEntryRow entry={makeEntry()} contentVisibility>
        <div>卡片内容</div>
      </MobileSwipeEntryRow>,
    );
    const row = container.querySelector("[data-swipe-row]") as HTMLElement;
    expect(row.className).toContain("[content-visibility:auto]");
    expect(row.className).toContain("[contain-intrinsic-size:auto_600px]");
  });
});
