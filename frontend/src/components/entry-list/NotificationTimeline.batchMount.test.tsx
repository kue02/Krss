import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";
import {
  TIMELINE_MIN_FIRST_WAVE_ROWS,
  TIMELINE_MOUNT_DEADLINE_MS,
  TIMELINE_ROW_ESTIMATE_PX,
  TIMELINE_WAVE_IDLE_TIMEOUT_MS,
  TIMELINE_WAVE_ROWS,
  computeFirstWaveRows,
  scheduleIdleCallback,
} from "./timeline-mount-batch";
import { resetDeferredRemovals } from "./deferred-removal";

/**
 * 通知时间线的**分批挂载**（perf）。
 *
 * 口径：50 行不再一次挂满（实测首根 596ms 的来源）—— 首屏只同步挂首批，剩下的按波次
 * 用 `requestIdleCallback({ timeout })` 补挂，补挂期间留等高空位（不跳滚动），
 * 并且有一条硬截止：必须在滚动标已读的 1s 宽限期之前把行全挂完。
 *
 * 手法说明（都是踩过坑的地方）：
 *   - **假定时器 + 逐波推进**：jsdom 没有 `requestIdleCallback` ⇒ 走 `setTimeout(120)`
 *     兜底。每一波单独一次 `act(() => advanceTimersByTime(120))`：下一波的定时器是在
 *     上一波渲完之后才排上的，一次 tick 到底只能走到第二行量（实测 1000ms 只到 24 行），
 *     所以级联要一推一渲交替；一次到底的那条用例断言的正是「硬截止」这条路。
 *   - 断言读的是**真实 DOM 行数 / 卡片 id**与占位高度，不是渲染轮数（轮数测不出宏任务）。
 *   - 「排了几个定时器」用监听 `setTimeout` 的 delay 来认，不用 `getTimerCount`：
 *     卡片自己的 400ms 复测也在同一张表里，纯计数区分不出是谁排的。
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
    i18n: { language: "zh-CN" },
  }),
}));

vi.mock("./EntryListItem", () => ({
  EntryContextMenuContent: () => null,
  SOCIAL_COLLAPSED_PX: 300,
  SOCIAL_CLIPPED_SLACK_PX: 8,
}));

vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: (selector: (state: unknown) => unknown) =>
    selector({ getTranslation: () => undefined }),
}));

vi.mock("@/hooks/useUISettings", () => ({
  // 与 NotificationTimeline.test.tsx 同一份桩：未读标记要走真实 HeroUI Badge 路径
  useUISettingKey: (key: string) =>
    key === "unreadStyle"
      ? "badge"
      : key === "unreadBadge"
        ? {
            content: "dot",
            placement: "top-left",
            size: 8,
            followAccent: true,
            color: "accent",
            customColor: null,
            variant: "primary",
            offset: 2,
          }
        : undefined,
  DEFAULT_UNREAD_BADGE: {},
}));

function entry(id: string, dayOffset: number, hour: number): Entry {
  const date = new Date(2026, 8, 18 - dayOffset, hour, 0, 0, 0);
  const iso = date.toISOString();
  return {
    id,
    feedId: "f1",
    title: `title ${id}`,
    content: `<p>body ${id}</p>`,
    publishedAt: iso,
    read: false,
    starred: false,
    muted: false,
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * `count` 个内容行：每条一个整点桶（不触发聚簇）⇒ 行数 == 条目数；
 * 每 12 条换一天 ⇒ 多个日期段（分批绝不能砍掉段头的日期行）。
 */
function manyEntries(count: number, idPrefix = "e"): Entry[] {
  return Array.from({ length: count }, (_, index) =>
    entry(`${idPrefix}${index}`, Math.floor(index / 12), 23 - (index % 12)),
  );
}

function renderTimeline(
  entries: Entry[],
  options: Partial<React.ComponentProps<typeof NotificationTimeline>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationTimeline
        entries={entries}
        feeds={new Map()}
        selectedEntryId={null}
        onSelectEntry={() => {}}
        granularity="hour"
        collapse="2"
        autoTranslate={false}
        targetLanguage="zh-CN"
        {...options}
      />
    </QueryClientProvider>,
  );
}

/** 已挂载的内容行（卡片 + 小节点；日期分隔行不带这个属性） */
const mountedRows = (container: HTMLElement) =>
  container.querySelectorAll("[data-timeline-row]").length;

/** 已挂载的卡片 id（轴序） */
const mountedCards = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-entry-id]")).map(
    (node) => node.dataset.entryId,
  );

/** 各段剩下多少行没挂（占位节点记的行数） */
const pendingRowCount = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>("[data-timeline-pending-rows]"),
  ).reduce((sum, node) => sum + Number(node.dataset.timelinePendingRows ?? 0), 0);

/** 占位总高度（补挂时不该跳滚动 ⇒ 未挂的行要有等高的位） */
const pendingHeight = (container: HTMLElement) =>
  pendingRowCount(container) * TIMELINE_ROW_ESTIMATE_PX;

/** 记录所有 `setTimeout` 的 delay，用来确认「分批到底排了哪几个定时器」 */
function spyOnTimeoutDelays() {
  const delays: number[] = [];
  const original = window.setTimeout.bind(window);
  const spy = vi
    .spyOn(window, "setTimeout")
    .mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      delays.push(ms ?? 0);
      return original(handler as (...a: unknown[]) => void, ms, ...args);
    }) as unknown as typeof window.setTimeout);
  return { delays, restore: () => spy.mockRestore() };
}

/**
 * 推进一波补挂（无 rIC ⇒ `setTimeout(120)` 兜底）。
 *
 * 一次 act 只推进**一个宏任务**（不用 `runAllTimers`）：同一时刻还挂着卡片各自的
 * 400ms 复测定时器，全跑会把它们一起放出来，断言就不是「第几波挂几行」了。
 */
function advanceWave() {
  act(() => {
    vi.advanceTimersByTime(TIMELINE_WAVE_IDLE_TIMEOUT_MS);
  });
}

/** 一推一渲交替，直到挂完（最多 maxWaves 波），返回最后挂到的行数 */
function flushWaves(container: HTMLElement, expectTotal: number, maxWaves = 12): number {
  let seen = mountedRows(container);
  for (let wave = 0; wave < maxWaves && seen < expectTotal; wave += 1) {
    advanceWave();
    seen = mountedRows(container);
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 18, 12, 0, 0) });
  resetDeferredRemovals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeline-mount-batch · 首批与兜底排程（纯函数层）", () => {
  it("首批 = max(最小首批, 视口高 ÷ 行估算 + 余量)", () => {
    // 视口量不出来（jsdom 首帧 / SSR）时也不低于最小首批
    expect(computeFirstWaveRows(0)).toBe(TIMELINE_MIN_FIRST_WAVE_ROWS);
    expect(computeFirstWaveRows(768)).toBe(TIMELINE_MIN_FIRST_WAVE_ROWS);
    // 高屏：1500/140 = 10.7 → ceil 11 + 2 = 13
    expect(computeFirstWaveRows(1500)).toBe(13);
  });

  it("没有 requestIdleCallback 时用 setTimeout 兜底，绝不用裸 rAF", () => {
    const raf = vi.fn();
    const fakeWindow = {
      requestAnimationFrame: raf,
      setTimeout: vi.fn(() => 7),
      clearTimeout: vi.fn(),
    };
    const cancel = scheduleIdleCallback(
      () => {},
      TIMELINE_WAVE_IDLE_TIMEOUT_MS,
      fakeWindow,
    );
    expect(fakeWindow.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      TIMELINE_WAVE_IDLE_TIMEOUT_MS,
    );
    expect(raf).not.toHaveBeenCalled();
    cancel?.();
    expect(fakeWindow.clearTimeout).toHaveBeenCalledWith(7);
  });

  it("有 requestIdleCallback 时带上 timeout（后台标签页不能被节流卡死）", () => {
    const requestIdleCallback = vi.fn(() => 42);
    const cancelIdleCallback = vi.fn();
    const cancel = scheduleIdleCallback(() => {}, 120, {
      requestIdleCallback,
      cancelIdleCallback,
    });
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120,
    });
    cancel?.();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });
});

describe("NotificationTimeline · 分批挂载", () => {
  it("50 行首屏只挂首批，其余行留等高空位", () => {
    const { container } = renderTimeline(manyEntries(50));

    const first = TIMELINE_MIN_FIRST_WAVE_ROWS;
    expect(mountedRows(container)).toBe(first);
    // 首批卡片就是最靠前的那几条（轴序不变：最新在上）
    expect(mountedCards(container)).toEqual(
      Array.from({ length: first }, (_, index) => `e${index}`),
    );
    // 剩下的行没建 DOM，但占了等高的位（否则补挂时滚动位置跳）
    expect(pendingHeight(container)).toBe((50 - first) * TIMELINE_ROW_ESTIMATE_PX);
  });

  it("补挂波次推进：每波 +TIMELINE_WAVE_ROWS 行，最终全挂且占位消失", () => {
    const { container } = renderTimeline(manyEntries(50));
    const total = 50;

    // 第一波：+12（离尾部还远，所以是精确的一波行量）
    advanceWave();
    const seen = TIMELINE_MIN_FIRST_WAVE_ROWS + TIMELINE_WAVE_ROWS;
    expect(mountedRows(container)).toBe(seen);
    expect(pendingHeight(container)).toBe((total - seen) * TIMELINE_ROW_ESTIMATE_PX);

    expect(flushWaves(container, total)).toBe(total);
    expect(mountedCards(container)).toHaveLength(total);
    // 挂完不留占位
    expect(container.querySelectorAll("[data-timeline-pending-rows]")).toHaveLength(0);
  });

  it("硬截止：一次推进（不逐波）也把行挂完 —— 滚动标已读只认 1s 宽限期内就位的行", () => {
    const { container } = renderTimeline(manyEntries(50));
    // 级联到不了这里（一次 tick 到底只走得动一波），靠 800ms 硬截止兜住
    act(() => {
      vi.advanceTimersByTime(TIMELINE_MOUNT_DEADLINE_MS + 1);
    });
    expect(mountedRows(container)).toBe(50);
    expect(pendingRowCount(container)).toBe(0);
    // 底线必须早于 useScrollMarkRead 的 MARK_READ_ON_SCROLL_GRACE_MS（1000）
    expect(TIMELINE_MOUNT_DEADLINE_MS).toBeLessThan(1000);
  });

  it("分批只排「一个波次兜底 + 一个硬截止」，不是一行一个定时器", () => {
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      renderTimeline(manyEntries(50));
      const wave = delays.filter((ms) => ms === TIMELINE_WAVE_IDLE_TIMEOUT_MS);
      const deadline = delays.filter((ms) => ms === TIMELINE_MOUNT_DEADLINE_MS);
      expect(wave).toHaveLength(1);
      expect(deadline).toHaveLength(1);
      // 自然高度上报合批的那一个宏任务兜底（delay 0）仍只有一次
      expect(delays.filter((ms) => ms === 0).length).toBeLessThanOrEqual(1);
    } finally {
      restore();
    }
  });

  it("行数不足首批时既不排波次也不排硬截止（小列表零额外排程）", () => {
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      const { container } = renderTimeline(manyEntries(5));
      expect(mountedRows(container)).toBe(5);
      expect(container.querySelectorAll("[data-timeline-pending-rows]")).toHaveLength(0);
      expect(delays).not.toContain(TIMELINE_WAVE_IDLE_TIMEOUT_MS);
      expect(delays).not.toContain(TIMELINE_MOUNT_DEADLINE_MS);
    } finally {
      restore();
    }
  });

  it("日期分隔行恒挂载（分批不砍段头，sticky 作用域不动）", () => {
    const { container } = renderTimeline(manyEntries(50));
    const datesBefore = container.querySelectorAll("[data-timeline-date]").length;
    const sectionsBefore = container.querySelectorAll("[data-timeline-section]").length;
    expect(datesBefore).toBeGreaterThan(1);

    expect(flushWaves(container, 50)).toBe(50);
    expect(container.querySelectorAll("[data-timeline-date]").length).toBe(datesBefore);
    expect(container.querySelectorAll("[data-timeline-section]").length).toBe(sectionsBefore);
  });

  it("换一批条目（切换 selection / 换订阅）→ 批次重置回首批", () => {
    const { container, rerender } = renderTimeline(manyEntries(50));
    expect(flushWaves(container, 50)).toBe(50);

    // 换一批条目（新订阅的 50 条，id 全不同）→ 又回到首批
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <NotificationTimeline
          entries={manyEntries(50, "f")}
          feeds={new Map()}
          selectedEntryId={null}
          onSelectEntry={() => {}}
          granularity="hour"
          collapse="2"
          autoTranslate={false}
          targetLanguage="zh-CN"
        />
      </QueryClientProvider>,
    );
    expect(mountedRows(container)).toBe(TIMELINE_MIN_FIRST_WAVE_ROWS);
    expect(mountedCards(container)[0]).toBe("f0");
  });

  it("选中的卡片即使在未补挂区间里也必须当场在 DOM 里（键盘 j/k 靠 querySelector + scrollIntoView）", () => {
    const entries = manyEntries(50);
    const { container } = renderTimeline(entries, { selectedEntryId: "e40" });
    // 没推进任何定时器
    expect(mountedCards(container)).toContain("e40");
    // 夹进首批的是「它和它之前的所有行」，不是整表
    expect(mountedRows(container)).toBe(41);
  });

  it("展开小节点 → 摊出来的行立刻可见（不等下一波）", () => {
    // 30 条挤在同一小时桶 ⇒ 3 张卡 + 一个「27 条」小节点 = 4 个内容行（都在首批内）
    const sameHour = Array.from({ length: 30 }, (_, index) => entry(`x${index}`, 0, 9));
    const { container } = renderTimeline(sameHour, { granularity: "hour" });

    expect(mountedRows(container)).toBe(4);
    const cluster = container.querySelector<HTMLElement>("[data-timeline-cluster]");
    expect(cluster?.dataset.timelineCluster).toBe("27");

    act(() => {
      cluster!.click();
    });
    // 摊开的 27 张卡全部立刻挂上：它们落在首批之外的话，用户点完什么都看不见
    expect(mountedCards(container)).toHaveLength(30);
    expect(pendingRowCount(container)).toBe(0);
  });
});
