import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";
import { resetDeferredRemovals } from "./deferred-removal";

/**
 * 29-1（用户 2026-09-25）：通知视图「正文悬停档」。
 *
 * 口径：骨架（中轴/时间戳/节点/日期分段）两档完全一致，只挪正文 ——
 * 悬停档下卡片只剩「来源行 + 标题」，正文进浮块（可移入不消失）；默认档一字不改。
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

describe("通知视图 · 悬停正文档（29-1）", () => {
  it("默认档零变化：正文照旧在卡片里，不挂悬停标记", () => {
    const { container } = renderTimeline([entry("a", 14, 10)]);
    const card = cardOf(container);
    expect(card.querySelector("[data-timeline-body]")).not.toBeNull();
    expect(card.getAttribute("data-body-on-hover")).toBeNull();
    expect(container.querySelector(FLOAT)).toBeNull();
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
    // 没悬浮就不该有浮块
    expect(container.querySelector(FLOAT)).toBeNull();
  });

  it("悬浮卡片 → 浮块带标题与正文；移出 250ms 才收；这期间进浮块就不收", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: true,
    });
    const card = cardOf(container);
    fireEvent.mouseEnter(card);

    const float = container.querySelector<HTMLElement>(FLOAT);
    expect(float).not.toBeNull();
    expect(float!.dataset.previewEntry).toBe("a");
    expect(float!.textContent).toContain("title a");
    const body = float!.querySelector<HTMLElement>("[data-preview-body]");
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("body a");

    // 移出卡片：250ms 内还在（留出移进浮块的时间）
    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(container.querySelector(FLOAT)).not.toBeNull();

    // 进浮块 ⇒ 清掉关闭定时器，再过多久都不收
    fireEvent.mouseEnter(container.querySelector(FLOAT)!);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector(FLOAT)).not.toBeNull();

    // 从浮块移出 ⇒ 250ms 后收掉（浮块直接从 DOM 撤，不留透明层）
    fireEvent.mouseLeave(container.querySelector(FLOAT)!);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector(FLOAT)).toBeNull();
  });

  it("关开关（bodyOnHover=false）时不挂浮块，即使鼠标悬浮", () => {
    const { container } = renderTimeline([entry("a", 14, 10)], {
      bodyOnHover: false,
    });
    fireEvent.mouseEnter(cardOf(container));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector(FLOAT)).toBeNull();
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
