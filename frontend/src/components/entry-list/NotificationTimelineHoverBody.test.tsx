import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import gsap from "gsap";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";
import { NotificationBodyPreview } from "./NotificationBodyPreview";
import { resetDeferredRemovals } from "./deferred-removal";

/**
 * 通知视图「正文悬停档」。
 *
 * 口径：骨架（中轴/时间戳/节点/日期分段）两档完全一致，只挪正文 ——
 * 悬停档下卡片只剩「来源行 + 标题」，正文进浮块（可移入不消失）；默认档一字不改。
 *
 * 浮块语义：hoverMode 下常挂（无 key、不卸载），无悬停时
 * `data-preview-visible="false"` 藏起；换条目只换 entry，DOM 节点不变。
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh-CN" },
  }),
}));

// 卡片里的右键菜单是条目那条共用菜单（含 react-query 依赖），这里不测它
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
  // 未读标记走真实的 HeroUI Badge 路径（只把设置项喂成默认值）
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

const FLOAT = "[data-notification-body-preview]";

function entry(id: string, hour: number, minute: number): Entry {
  const date = new Date(2026, 8, 18, hour, minute, 0, 0);
  return {
    id,
    feedId: "f1",
    title: `title ${id}`,
    content: `<p>body ${id} with some text</p>`,
    publishedAt: date.toISOString(),
    read: false,
    starred: false,
    muted: false,
    createdAt: date.toISOString(),
    updatedAt: date.toISOString(),
  };
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

const cardOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-timeline-card]")!;

const floatOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(FLOAT);

const isFloatVisible = (float: HTMLElement | null) =>
  float?.getAttribute("data-preview-visible") === "true";

beforeEach(() => {
  // 只 fake Date 与 250ms 那对定时器：浮块的延迟关要用它断言
  vi.useFakeTimers({
    now: new Date(2026, 8, 18, 12, 0, 0),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  });
  resetDeferredRemovals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("通知视图 · 悬停正文档", () => {
  it("落点规则：挂指针右下，竖直不越过所悬停卡片下沿（防遮标题）", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: true,
    });
    const card = cardOf(container);
    // jsdom 里 rect 全 0，这里喂一张真卡片：上沿 100 / 下沿 160
    card.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 160,
        left: 40,
        right: 640,
        width: 600,
        height: 60,
        x: 40,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.mouseEnter(card, { clientX: 300, clientY: 130 });
    const float = floatOf(container)!;
    const x = Number(gsap.getProperty(float, "x"));
    const y = Number(gsap.getProperty(float, "y"));
    // x：指针右侧 20px（jsdom 里 offsetWidth=0 ⇒ 不翻边）
    expect(x).toBe(320);
    // y：cardBottom(160)+12 = 172 —— 而不是「指针 y+20 = 150」压住标题
    expect(y).toBe(172);
  });

  it('32-2 文章档：anchorMode="pointer" 以指针为中心（yPercent -50、不做卡片避让）', () => {
    const view = render(
      <NotificationBodyPreview
        entry={entry("a", 14, 10)}
        visible
        anchor={{ x: 300, y: 130, cardTop: 100, cardBottom: 160 }}
        feedName="f"
        autoTranslate={false}
        targetLanguage="zh-CN"
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
        anchorMode="pointer"
      />,
    );
    const float = view.container.querySelector(FLOAT)!;
    // 与图片视图 hover-img 同款：x/y 直接取指针坐标，两个方向都居中
    expect(Number(gsap.getProperty(float, "x"))).toBe(300);
    expect(Number(gsap.getProperty(float, "y"))).toBe(130);
    expect(Number(gsap.getProperty(float, "yPercent"))).toBe(-50);
    // 同一份组件在通知档仍是「挂指针右下 + 不遮卡片」（上一条用例的 172）
  });

  it("默认档零变化：正文照旧在卡片里，不挂悬停标记", () => {
    const { container } = renderTimeline([entry("a", 14, 10)]);
    const card = cardOf(container);
    expect(card.querySelector("[data-timeline-body]")).not.toBeNull();
    expect(card.getAttribute("data-body-on-hover")).toBeNull();
    expect(floatOf(container)).toBeNull();
  });

  it("悬停档：卡片只剩来源行 + 标题，正文/展开按钮/展开容器/拖高手柄都没有", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: true,
    });
    const card = cardOf(container);
    expect(card.getAttribute("data-body-on-hover")).toBe("true");
    expect(card.querySelector("[data-timeline-body]")).toBeNull();
    expect(card.querySelector("[data-timeline-expand]")).toBeNull();
    expect(card.querySelector("[data-timeline-full]")).toBeNull();
    expect(card.querySelector("[data-timeline-resize]")).toBeNull();
    // 标题与来源行仍在（只挪正文，不挪骨架）
    expect(card.textContent).toContain("title a");
    expect(card.getAttribute("data-entry-id")).toBe("a");
    // 没悬浮时浮块常挂但隐藏（不卸载，用 data-preview-visible 判可见）
    const float = floatOf(container);
    expect(float).not.toBeNull();
    expect(isFloatVisible(float)).toBe(false);
  });

  it("悬浮卡片 → 浮块带标题与正文；移出 250ms 才藏；这期间进浮块就不藏", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: true,
    });
    const card = cardOf(container);
    fireEvent.mouseEnter(card);

    const float = floatOf(container);
    expect(float).not.toBeNull();
    expect(isFloatVisible(float)).toBe(true);
    expect(float!.dataset.previewEntry).toBe("a");
    expect(float!.textContent).toContain("title a");
    const body = float!.querySelector<HTMLElement>("[data-preview-body]");
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("body a");

    // 移出卡片：250ms 内还可见（留出移进浮块的时间）
    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(isFloatVisible(floatOf(container))).toBe(true);

    // 进浮块 ⇒ 清掉关闭定时器，再过多久都不藏
    fireEvent.mouseEnter(floatOf(container)!);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(isFloatVisible(floatOf(container))).toBe(true);

    // 从浮块移出 ⇒ 250ms 后藏起（节点仍在，常挂不卸载）
    fireEvent.mouseLeave(floatOf(container)!);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const hidden = floatOf(container);
    expect(hidden).not.toBeNull();
    expect(isFloatVisible(hidden)).toBe(false);
  });

  it("换条目不重新挂载：同一个 DOM 节点，data-preview-entry 跟着变", () => {
    const { container } = renderTimeline(
      [entry("a", 14, 10), entry("b", 14, 20)],
      { bodyOnHover: true },
    );
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>("[data-timeline-card]"),
    );
    expect(cards).toHaveLength(2);

    const cardA = container.querySelector<HTMLElement>(
      '[data-timeline-card][data-entry-id="a"]',
    )!;
    const cardB = container.querySelector<HTMLElement>(
      '[data-timeline-card][data-entry-id="b"]',
    )!;
    expect(cardA).toBeDefined();
    expect(cardB).toBeDefined();

    fireEvent.mouseEnter(cardA!);
    const first = floatOf(container);
    expect(first).not.toBeNull();
    expect(isFloatVisible(first)).toBe(true);
    expect(first!.dataset.previewEntry).toBe("a");

    // 从 A 移到 B：先离 A（起 250ms 延迟关），再进 B（取消关闭、换条目）
    fireEvent.mouseLeave(cardA!);
    fireEvent.mouseEnter(cardB!);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    const second = floatOf(container);
    expect(second).not.toBeNull();
    // 同一个 DOM 节点，没有重新挂载
    expect(second).toBe(first);
    expect(isFloatVisible(second)).toBe(true);
    expect(second!.dataset.previewEntry).toBe("b");
    expect(second!.textContent).toContain("body b");
  });

  it("关开关（bodyOnHover=false）时不挂浮块，即使鼠标悬浮", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: false,
    });
    fireEvent.mouseEnter(cardOf(container));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(floatOf(container)).toBeNull();
  });

  it("触屏（hover: none）自动降级：开关开着也把正文留在卡片里", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("hover: none"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })),
    );
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: true,
    });
    const card = cardOf(container);
    expect(card.getAttribute("data-body-on-hover")).toBeNull();
    expect(card.querySelector("[data-timeline-body]")).not.toBeNull();
  });
});
