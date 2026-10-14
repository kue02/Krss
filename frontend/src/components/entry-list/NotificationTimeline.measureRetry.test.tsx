import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";
import {
  TIMELINE_MEASURE_RETRY_MS,
  useMeasureRetryHub,
} from "./timeline-measure-retry";
import {
  TIMELINE_MOUNT_DEADLINE_MS,
  TIMELINE_WAVE_IDLE_TIMEOUT_MS,
} from "./timeline-mount-batch";
import { resetDeferredRemovals } from "./deferred-removal";

/**
 * 通知时间线的**共享复测定时器**（perf）。
 *
 * 改前：每张卡片自己 `setTimeout(400)` 两次（自然高度复测 + 截断判定复测）
 * ⇒ 50 张卡 = 100 个独立宏任务，每个回调读一次 `scrollHeight` 强制布局
 * （真机 tracing TimerFire + TimerBase.run 合计 1017ms）。
 * 改后：卡片把回调注册进父级，全表任一时刻最多**一个** `setTimeout`。
 *
 * 这里同时钉住**功能终态**：复测这件事本身不能因为合批而失效 ——
 * 「图片异步加载把高度改掉」之后长贴判定与截断判定仍要跟上（>300px 判据一字未动）。
 *
 * 手法：假定时器 + 监听 `window.setTimeout` 的 delay 计数（不用 `getTimerCount`：
 * 分批挂载的波次兜底也在同一张表里，纯计数区分不出是谁排的）。
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

function entry(id: string, dayOffset = 0, hour = 9, extra: Partial<Entry> = {}): Entry {
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
    ...extra,
  };
}

/** 很长的正文：是否算「长贴」由高度桩决定，与字数无关 */
function longEntry(id = "long"): Entry {
  return entry(id, 0, 14, { content: `<p>${"很长的正文 ".repeat(200)}</p>` });
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

/** 只记录 `setTimeout` 的 delay（真实实现照常跑） */
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
 * 控制「自然高度」的高度桩（jsdom 不做布局，`scrollHeight` 恒 0）。
 * 返回一个 setter：改了它就等于「图片异步加载完，高度变了」，复测必须跟上。
 */
function stubScrollHeight(getter: () => number) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => getter(),
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    }
  };
}

const tick = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/**
 * 复测到点 + 让「上报合批」那一个宏任务（`setTimeout(0)`，上一轮 a1bb2e8 的设计）落地。
 *
 * 假定时器不会替你把「回调里新排的 0ms 定时器」算进同一次推进，所以量到高度之后
 * 还要再 tick 一次才会看到 `naturalHeights` 生效 —— 真机上是下一个宏任务，肉眼无感。
 */
const tickRetry = () => {
  tick(TIMELINE_MEASURE_RETRY_MS);
  tick(1);
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 18, 12, 0, 0) });
  resetDeferredRemovals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMeasureRetryHub · 定时器收敛（单元层）", () => {
  /** 一个只用来拿 hub 的宿主组件 */
  function Probe({
    onRegister,
    delayMs,
  }: {
    onRegister: (register: ReturnType<typeof useMeasureRetryHub>) => void;
    delayMs?: number;
  }) {
    const register = useMeasureRetryHub(delayMs);
    onRegister(register);
    return null;
  }

  it("N 个回调只排 1 个共享 setTimeout，到点依次执行", () => {
    let register!: ReturnType<typeof useMeasureRetryHub>;
    render(<Probe onRegister={(fn) => (register = fn)} />);
    const runs: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      register(() => runs.push(i));
    }
    // 关键断言：50 个回调 ≠ 50 个定时器（改前是 100 个宏任务）
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      register(() => runs.push(999));
      expect(delays.filter((ms) => ms === TIMELINE_MEASURE_RETRY_MS)).toHaveLength(0);
    } finally {
      restore();
    }

    tick(TIMELINE_MEASURE_RETRY_MS);
    expect(runs).toHaveLength(51);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("每个回调不早于自己注册后 400ms 执行（分批挂载的后续波次不被提前量测）", () => {
    let register!: ReturnType<typeof useMeasureRetryHub>;
    render(<Probe onRegister={(fn) => (register = fn)} />);
    const t0 = Date.now();
    const firedAt: number[] = [];
    register(() => firedAt.push(Date.now()));
    tick(200);
    // 第二波卡片在 +200ms 时才注册
    register(() => firedAt.push(Date.now()));
    expect(firedAt).toHaveLength(0);
    tick(200);
    // 第一条到点（t0+400）：只跑它自己，不能把第二条一起带走（那时它才注册了 200ms）
    expect(firedAt).toEqual([t0 + 400]);
    tick(200);
    // 第二条仍等到自己注册后 400ms
    expect(firedAt).toEqual([t0 + 400, t0 + 600]);
  });

  it("回调只执行一次；注销后不再执行", () => {
    let register!: ReturnType<typeof useMeasureRetryHub>;
    render(<Probe onRegister={(fn) => (register = fn)} />);
    const fired = vi.fn();
    const cancelled = vi.fn();
    register(fired);
    const unregister = register(cancelled);
    unregister();
    tick(TIMELINE_MEASURE_RETRY_MS);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    tick(TIMELINE_MEASURE_RETRY_MS);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("delay 可注入（功能用例仍用 400ms 默认值）", () => {
    let register!: ReturnType<typeof useMeasureRetryHub>;
    render(<Probe onRegister={(fn) => (register = fn)} delayMs={100} />);
    const fired = vi.fn();
    register(fired);
    tick(99);
    expect(fired).not.toHaveBeenCalled();
    tick(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("宿主卸载 → 排程与待处理回调一起丢，不会再回调", () => {
    let register!: ReturnType<typeof useMeasureRetryHub>;
    const view = render(<Probe onRegister={(fn) => (register = fn)} />);
    const fired = vi.fn();
    register(fired);
    view.unmount();
    tick(TIMELINE_MEASURE_RETRY_MS * 2);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe("NotificationTimeline · 复测收敛到父级一个定时器", () => {
  it("50 张卡挂载只排一个复测定时器（改前是 100 个宏任务）", () => {
    const entries = Array.from({ length: 50 }, (_, index) =>
      entry(`e${index}`, Math.floor(index / 12), 23 - (index % 12)),
    );
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      renderTimeline(entries);
      const retry = delays.filter((ms) => ms === TIMELINE_MEASURE_RETRY_MS);
      // 首批 12 张卡 × 两处量测 = 24 个回调，但只排 1 个定时器
      expect(retry).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("50 张卡全挂完之后，400ms 复测定时器总数远小于 100（改前每卡两处各一个）", () => {
    const entries = Array.from({ length: 50 }, (_, index) =>
      entry(`e${index}`, Math.floor(index / 12), 23 - (index % 12)),
    );
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      const { container } = renderTimeline(entries);
      // 首批 12 张卡 × 两处量测 = 24 个回调 → 挂载那一刻只排了 1 个定时器
      expect(delays.filter((ms) => ms === TIMELINE_MEASURE_RETRY_MS)).toHaveLength(1);

      // 一路把 50 行补挂完、复测全部到点（分批每挂上一波就注册一批回调）
      for (let wave = 0; wave < 12; wave += 1) {
        tick(TIMELINE_WAVE_IDLE_TIMEOUT_MS);
      }
      tick(TIMELINE_MOUNT_DEADLINE_MS + TIMELINE_MEASURE_RETRY_MS + 10);
      expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(50);

      // 复测定时器按「注册波次」排，不按「卡片数」排：50 卡 × 2 处 = 100 个回调，
      // 改前 = 100 个宏任务（tracing 里 TimerFire 合计 1017ms），现在个位数。
      const retryTimers = delays.filter((ms) => ms === TIMELINE_MEASURE_RETRY_MS).length;
      expect(retryTimers).toBeLessThanOrEqual(10);
    } finally {
      restore();
    }
  });

  it("复测仍生效：图片异步加载把高度改掉后，长贴照样自动展开（终态不变）", () => {
    let height = 0;
    const restore = stubScrollHeight(() => height);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      // 高度还没量出来：按短贴处理（不先展开再塌回）
      expect(container.querySelector("[data-timeline-full='long']")).toBeNull();
      expect(
        container.querySelector<HTMLElement>("[data-timeline-body]")?.dataset
          .timelineBody,
      ).toBe("2");

      // 图片加载完 → 高度变长贴；复测到点才看得见这个新值
      height = 800;
      tickRetry();
      expect(container.querySelector("[data-timeline-full='long']")).not.toBeNull();
      expect(container.querySelector("[data-timeline-body]")).toBeNull();
      // 收起按钮在、「展开全文」按钮不出（与逐卡 setTimeout 那版一致）
      expect(container.querySelector("[data-timeline-expand]")).toBeNull();
      expect(
        container.querySelector("[data-timeline-resize='long']"),
      ).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("复测仍生效：短贴不会因复测被误展开（>300px 判据一字未动）", () => {
    const restore = stubScrollHeight(() => 260);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      tickRetry();
      tick(TIMELINE_MEASURE_RETRY_MS);
      expect(container.querySelector("[data-timeline-full='long']")).toBeNull();
      expect(
        container.querySelector<HTMLElement>("[data-timeline-body]")?.style
          .webkitLineClamp,
      ).toBe("2");
    } finally {
      restore();
    }
  });

  it("截断判定的复测也走共享定时器：复测后被截断的卡片才出「展开全文」", () => {
    // scrollHeight 200 / clientHeight 40 ⇒ 被截断；挂载首轮 jsdom 里量不到（都 0），
    // 复测到点才把按钮补出来 —— 与改前每张卡自己 setTimeout(measure, 400) 同一终态。
    let clipped = false;
    const scrollDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const clientDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => (clipped ? 200 : 0),
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => (clipped ? 40 : 0),
    });
    try {
      const { container } = renderTimeline([entry("a")]);
      expect(container.querySelector("[data-timeline-expand]")).toBeNull();
      clipped = true;
      tickRetry();
      expect(container.querySelector("[data-timeline-expand]")).not.toBeNull();
      // 共享定时器已经把这批回调消费干净（每个回调只跑一次）
      tickRetry();
      expect(container.querySelectorAll("[data-timeline-expand]")).toHaveLength(1);
    } finally {
      if (scrollDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDescriptor);
      }
      if (clientDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientHeight",
          clientDescriptor,
        );
      }
    }
  });

  it("悬停档（卡片里没有正文预览）完全不注册复测", () => {
    const { delays, restore } = spyOnTimeoutDelays();
    try {
      renderTimeline(
        Array.from({ length: 20 }, (_, index) => entry(`e${index}`)),
        { bodyOnHover: true },
      );
      expect(delays.filter((ms) => ms === TIMELINE_MEASURE_RETRY_MS)).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
