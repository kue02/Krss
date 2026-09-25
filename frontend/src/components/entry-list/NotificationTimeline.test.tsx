import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";
import {
  resetDeferredRemovals,
  deferredRemovalIds,
} from "./deferred-removal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
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

function entry(id: string, publishedAt: string, extra: Partial<Entry> = {}): Entry {
  const date = new Date(publishedAt);
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
    ...extra,
  };
}

function localIso(day: number, hour: number, minute: number) {
  return new Date(2026, 8, day, hour, minute, 0, 0).toISOString();
}

/**
 * 15 批的这组用例用的是**固定日期**（2026-09-18 / 09-17），断言里还写着「今天 / 昨天」这两条
 * 相对标签 —— 不钉住时钟的话，只有「真实日期正好是 2026-09-18」那一天才会绿（09-19 起必红）。
 * 只 fake `Date`，不动 setTimeout/interval：RTL 的异步等待需要真定时器。
 */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 18, 12, 0, 0), toFake: ["Date"] });
  resetDeferredRemovals();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderTimeline(
  entries: Entry[],
  options: Partial<React.ComponentProps<typeof NotificationTimeline>> = {},
) {
  const onSelectEntry = vi.fn();
  // 24-8 起时间线自己标已读（useMarkAsRead），必须包一层 QueryClientProvider
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NotificationTimeline
        entries={entries}
        feeds={new Map()}
        selectedEntryId={null}
        onSelectEntry={onSelectEntry}
        granularity="hour"
        collapse="2"
        autoTranslate={false}
        targetLanguage="zh-CN"
        {...options}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSelectEntry };
}

const rowsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-timeline-row]"));

describe("NotificationTimeline · 主干形态（15-1）", () => {
  it("中轴 + 卡片左右交替：每行一个节点，行内同时有节点与卡片", () => {
    const entries = [
      entry("a", localIso(18, 14, 10)),
      entry("b", localIso(18, 13, 10)),
      entry("c", localIso(18, 12, 10)),
    ];
    const { container } = renderTimeline(entries);

    // 轴在中间（交替布局），1px 竖线
    expect(container.querySelector("[data-timeline-axis]")).not.toBeNull();
    expect(
      screen.getByTestId("notification-timeline").dataset.timelineLayout,
    ).toBe("alternating");

    const rows = rowsOf(container);
    expect(rows).toHaveLength(3);
    // 左右交替落位
    expect(
      Array.from(container.querySelectorAll("[data-timeline-card]")).map(
        (card) => (card as HTMLElement).dataset.timelineSide,
      ),
    ).toEqual(["left", "right", "left"]);
    // 时间戳与节点在**同一行**（紧贴节点的结构前提；像素距离由真机量）
    for (const row of rows) {
      expect(row.querySelector("[data-timeline-dot]")).not.toBeNull();
      expect(row.querySelector("[data-timeline-time]")).not.toBeNull();
      expect(row.querySelector("[data-entry-id]")).not.toBeNull();
    }
  });

  it("最新在上：行序与条目顺序一致（列表已是 DESC）", () => {
    const entries = [
      entry("newest", localIso(18, 14, 30)),
      entry("older", localIso(18, 10, 30)),
    ];
    const { container } = renderTimeline(entries);
    expect(
      Array.from(container.querySelectorAll("[data-entry-id]")).map(
        (node) => (node as HTMLElement).dataset.entryId,
      ),
    ).toEqual(["newest", "older"]);
  });

  it("跨天插日期分隔，且日期行不是卡片行", () => {
    const entries = [
      entry("a", localIso(18, 9, 0)),
      entry("b", localIso(17, 9, 0)),
    ];
    const { container } = renderTimeline(entries);
    const dates = Array.from(container.querySelectorAll("[data-timeline-date]"));
    expect(dates.map((node) => (node as HTMLElement).dataset.timelineDate)).toEqual([
      "timeline.today · 9月18日 周五",
      "timeline.yesterday · 9月17日 周四",
    ]);
    expect(dates.every((node) => node.querySelector("[data-entry-id]") === null)).toBe(true);
  });

  it("密集条目吸成小节点 + 计数，点一下就地展开、再点收回", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, localIso(17, 20 - index, 0)),
    );
    const { container, onSelectEntry } = renderTimeline(entries, { granularity: "day" });

    const cluster = () => container.querySelector<HTMLElement>("[data-timeline-cluster]");
    expect(cluster()?.dataset.timelineCluster).toBe("3");
    expect(cluster()?.textContent).toContain("timeline.entries_count:3");
    // 吸掉的 3 条确实不在轴上（只有 3 张卡）
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(3);
    // 头节点上有「整桶 N 条」的计数
    expect(container.textContent).toContain("timeline.entries_count:6");

    fireEvent.click(cluster()!);
    // 就地展开：小节点还在（要能收回去），它的条目插在下面 → 轴上多出 3 条
    expect(container.querySelectorAll("[data-timeline-cluster]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(6);
    expect(cluster()?.textContent).toContain("timeline.collapse");
    // 展开按钮不是「选中条目」，不该打开详情
    expect(onSelectEntry).not.toHaveBeenCalled();

    fireEvent.click(cluster()!);
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(3);
  });
});

describe("NotificationTimeline · 折叠 / 展开（15-3）", () => {
  it("默认折叠：正文挂着设置的行数（2 行）", () => {
    const { container } = renderTimeline([entry("a", localIso(18, 14, 10))]);

    const body = container.querySelector<HTMLElement>("[data-timeline-body]");
    expect(body?.dataset.timelineBody).toBe("2");
    expect(body?.style.webkitLineClamp).toBe("2");
  });

  it("折叠行数按档位走：1 行 / 3 行 / 全文（全文不折、也不出展开按钮）", () => {
    const entries = [entry("a", localIso(18, 14, 10))];

    const one = renderTimeline(entries, { collapse: "1" });
    expect(
      one.container.querySelector<HTMLElement>("[data-timeline-body]")?.style
        .webkitLineClamp,
    ).toBe("1");
    one.unmount();

    const three = renderTimeline(entries, { collapse: "3" });
    expect(
      three.container.querySelector<HTMLElement>("[data-timeline-body]")?.style
        .webkitLineClamp,
    ).toBe("3");
    three.unmount();

    const full = renderTimeline(entries, { collapse: "full" });
    const fullBody = full.container.querySelector<HTMLElement>("[data-timeline-body]");
    expect(fullBody?.dataset.timelineBody).toBe("full");
    expect(fullBody?.style.webkitLineClamp).toBe("");
    expect(full.container.querySelector("[data-timeline-expand]")).toBeNull();
  });

  it("就地展开：正文级完整渲染进固定高度容器（默认 380px、内部滚动），轴不动", () => {
    // jsdom 不做布局（scrollHeight 恒为 0）→ 先把高度桩打上，让「被截断」这个前提成立；
    // 桩必须在 render 之前生效，否则首轮 effect 量出来是不截断、按钮不出现。
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 40,
    });

    try {
      const { container } = renderTimeline([entry("a", localIso(18, 14, 10))]);
      const body = container.querySelector<HTMLElement>("[data-timeline-body]");
      const toggle = container.querySelector<HTMLButtonElement>("[data-timeline-expand]");
      expect(toggle).not.toBeNull();
      expect(body?.style.webkitLineClamp).toBe("2");
      const rowBefore = body!.closest("[data-timeline-row]");

      fireEvent.click(toggle!);

      // 24-8：展开态不再是摘 clamp，而是正文级完整渲染的固定容器
      const full = container.querySelector<HTMLElement>("[data-timeline-full='a']");
      expect(full).not.toBeNull();
      expect(full?.dataset.timelineFullHeight).toBe("380");
      expect(full?.style.height).toBe("380px");
      expect(full?.className).toContain("overflow-y-auto");
      // 全文按阅读区管道排版（标题/正文都在里面，不再是纯文字预览）
      expect(full?.textContent).toContain("body a");
      // 轴上的位置没变：还是同一行、同一行的节点还在
      expect(full!.closest("[data-timeline-row]")).toBe(rowBefore);
      expect(rowBefore?.querySelector("[data-timeline-dot]")).not.toBeNull();
      // 右下角拖拽手柄在
      expect(
        container.querySelector("[data-timeline-resize='a']"),
      ).not.toBeNull();
      // 收起回到预览态
      const collapse = full!
        .closest("[data-timeline-row]")!
        .querySelector<HTMLButtonElement>("button");
      fireEvent.click(collapse!);
      expect(
        container.querySelector("[data-timeline-full='a']"),
      ).toBeNull();
      expect(
        container.querySelector<HTMLElement>("[data-timeline-body]")?.style
          .webkitLineClamp,
      ).toBe("2");
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
    }
  });
});

describe("NotificationTimeline · 长贴自动展开（与社交视图同语义）", () => {
  /**
   * jsdom 不做布局（scrollHeight 恒为 0）→ 用桩控制「自然高度」，
   * 卡片上报的正是这个值，父级拿它判长贴（> 300px）。
   */
  function stubNaturalHeight(height: number) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    return () => {
      if (descriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          descriptor,
        );
      }
    };
  }

  /** 很长的正文（自然高度一定超 300px，判据走高度桩、不走字数） */
  function longEntry(): Entry {
    return entry("long", localIso(18, 14, 10), {
      content: `<p>${"很长的正文 ".repeat(200)}</p>`,
    });
  }

  it("开关关时按档位钳制（长贴也不展开）", () => {
    const restore = stubNaturalHeight(800);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: false,
      });
      const body = container.querySelector<HTMLElement>("[data-timeline-body]");
      expect(body?.dataset.timelineBody).toBe("2");
      expect(body?.style.webkitLineClamp).toBe("2");
    } finally {
      restore();
    }
  });

  it("开关开 + 长贴直接是展开态（正文全文容器 + 收起按钮，无需点击）", () => {
    const restore = stubNaturalHeight(800);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      // 展开态分支：正文级全文容器（data-timeline-full），不是预览钳制体
      expect(
        container.querySelector("[data-timeline-full='long']"),
      ).not.toBeNull();
      expect(container.querySelector("[data-timeline-body]")).toBeNull();
      // 展开态的收起按钮在（文案 timeline.collapse），不出「展开全文」按钮
      expect(container.querySelector("[data-timeline-expand]")).toBeNull();
      // 右下角拖拽手柄在（展开态容器专属）
      expect(
        container.querySelector("[data-timeline-resize='long']"),
      ).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("自动展开后点收起能收起且不再弹开（显式收起记忆）", () => {
    const restore = stubNaturalHeight(800);
    const rerenderSelect = vi.fn();
    const rerenderClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    try {
      const { container, rerender } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      expect(
        container.querySelector("[data-timeline-full='long']"),
      ).not.toBeNull();
      // 点展开态里的收起按钮
      const collapse = container
        .querySelector("[data-timeline-full='long']")!
        .closest("[data-timeline-row]")!
        .querySelector<HTMLButtonElement>("button")!;
      fireEvent.click(collapse);
      // 回到预览态：按档位钳制（自动展开的记忆只管「不再自动弹开」，
      // 用户点「展开全文」仍可手动再展开）
      expect(container.querySelector("[data-timeline-full='long']")).toBeNull();
      const body = container.querySelector<HTMLElement>("[data-timeline-body]");
      expect(body?.dataset.timelineBody).toBe("2");
      // 同一高度值再报一遍（400ms 复测 / 重渲染）也不弹开
      rerender(
        <QueryClientProvider client={rerenderClient}>
          <NotificationTimeline
            entries={[longEntry()]}
            feeds={new Map()}
            selectedEntryId={null}
            onSelectEntry={rerenderSelect}
            granularity="hour"
            collapse="2"
            autoExpandLong
            autoTranslate={false}
            targetLanguage="zh-CN"
          />
        </QueryClientProvider>,
      );
      expect(container.querySelector("[data-timeline-full='long']")).toBeNull();
    } finally {
      restore();
    }
  });

  it("开关开 + 短贴仍按档位钳制", () => {
    const restore = stubNaturalHeight(40);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      const body = container.querySelector<HTMLElement>("[data-timeline-body]");
      expect(body?.dataset.timelineBody).toBe("2");
      expect(body?.style.webkitLineClamp).toBe("2");
    } finally {
      restore();
    }
  });

  it("高度没量出来前按短贴处理（不先展开再塌回）", () => {
    const restore = stubNaturalHeight(0);
    try {
      const { container } = renderTimeline([longEntry()], {
        collapse: "2",
        autoExpandLong: true,
      });
      const body = container.querySelector<HTMLElement>("[data-timeline-body]");
      expect(body?.dataset.timelineBody).toBe("2");
      expect(body?.style.webkitLineClamp).toBe("2");
    } finally {
      restore();
    }
  });
});

describe("NotificationTimeline · 与列表的契约", () => {
  it("点卡片 = 选中该条目 + 顺手标已读（记 deferred，离列表才摘）", () => {
    const { container, onSelectEntry } = renderTimeline([entry("a", localIso(18, 14, 10))]);
    fireEvent.click(container.querySelector("[data-entry-id]")!);
    expect(onSelectEntry).toHaveBeenCalledWith("a");
    // 24-8：原来第三栏 EntryContent 干的标已读，现在点开即标（24-1 同语义）
    expect(deferredRemovalIds()).toContain("a");
  });

  it("选中的条目在时间线内展开（桌面端没有第三栏了）+ 收起交回列表", () => {
    const onCloseEntry = vi.fn();
    const { container } = renderTimeline([entry("a", localIso(18, 14, 10))], {
      selectedEntryId: "a",
      onCloseEntry,
    });
    // 不用点展开按钮，选中即展开
    expect(
      container.querySelector("[data-timeline-full='a']"),
    ).not.toBeNull();
    // 收起：回到预览态 + 把选中交回列表
    const collapse = container
      .querySelector("[data-timeline-full='a']")!
      .closest("[data-timeline-row]")!
      .querySelector<HTMLButtonElement>("button")!;
    fireEvent.click(collapse);
    expect(onCloseEntry).toHaveBeenCalledTimes(1);
  });

  it("展开后跟随：卡片顶部被顶出视口上方才向上拉回，否则不动", async () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 40,
    });
    const scrollBy = vi.fn();
    const originalScrollBy = window.scrollBy;
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;

    try {
      const { container } = renderTimeline([entry("a", localIso(18, 14, 10))]);
      fireEvent.click(container.querySelector("[data-timeline-expand]")!);
      const card = container.querySelector<HTMLElement>(
        "[data-timeline-card][data-entry-id='a']",
      );
      expect(card).not.toBeNull();
      // 卡片顶部被顶到视口上方 → 向上拉回（只拉卡片，不碰展开区底部）
      card!.getBoundingClientRect = () =>
        ({
          top: -50,
          bottom: 500,
          left: 0,
          right: 300,
          width: 300,
          height: 550,
        }) as DOMRect;
      // 跟随 effect 走 rAF，等它跑完
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollBy).toHaveBeenCalledWith({ top: -62 });
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
      window.scrollBy = originalScrollBy;
    }
  });

  it("窄栏合一栏关掉则始终交替（autoSingleSide=false）", () => {
    const { container } = renderTimeline(
      [
        entry("a", localIso(18, 14, 10)),
        entry("b", localIso(18, 13, 10)),
      ],
      { autoSingleSide: false },
    );
    expect(
      container.querySelector<HTMLElement>("div[data-testid='notification-timeline']")?.dataset
        .timelineLayout,
    ).toBe("alternating");
  });

  it("回报给父级的可选条目 = 轴上的卡片（不含被吸进小节点的）", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, localIso(17, 20 - index, 0)),
    );
    const onSelectableEntriesChange = vi.fn();
    const { container } = renderTimeline(entries, {
      granularity: "day",
      onSelectableEntriesChange,
    });

    const reported =
      onSelectableEntriesChange.mock.calls[
        onSelectableEntriesChange.mock.calls.length - 1
      ]?.[0] as Entry[];
    expect(reported.map((item) => item.id)).toEqual(["a", "b", "c"]);

    // 展开那一簇之后，轴上的条目变多，回报也跟着更新
    fireEvent.click(container.querySelector("[data-timeline-cluster]")!);
    const after =
      onSelectableEntriesChange.mock.calls[
        onSelectableEntriesChange.mock.calls.length - 1
      ]?.[0] as Entry[];
    expect(after.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("NotificationTimeline · 日期吸顶（26-1 重做）", () => {
  it("日期行原生 sticky：top-0 + 全宽条，行高与间距不变（2026-09-25 回到 2423cda 那版）", () => {
    const { container } = renderTimeline([
      entry("a", localIso(18, 9, 0)),
      entry("b", localIso(17, 9, 0)),
    ]);
    const dates = Array.from(
      container.querySelectorAll<HTMLElement>("[data-timeline-date]"),
    );
    expect(dates).toHaveLength(2);
    for (const date of dates) {
      // 原生 sticky 吸顶：无 scroll 监听、无 fixed，定位纯 CSS
      expect(date.className).toContain("sticky");
      // 吸在自己的行位里（原来的位置），不是飘在列表上方的居中胶囊
      expect(date.className).toContain("top-0");
      expect(date.className).not.toContain("top-2");
      // 形态 = 全宽条：同色半透底 + 模糊 + 底部 1px inset 分隔线
      expect(date.className).toContain("bg-background/85");
      expect(date.className).toContain("backdrop-blur-md");
      expect(date.style.boxShadow).toContain("inset");
      // 用户 9-25：「原来是在条目标题上方」= 单栏左对齐到卡片列 / 交替居中
      expect(date.className).not.toContain("rounded-full");
      expect(date.className).not.toContain("mx-auto");
      expect(date.className).not.toContain("w-max");
      // 文字仍是原来那颗无描边无投影的小 pill
      const label = date.querySelector("span");
      expect(label?.className).toContain("rounded-full");
      expect(label?.className).toContain("bg-background");
      expect(label?.className).not.toContain("border");
    }
  });

  it("日期行不挡卡片点击：自身不是按钮、无 pointer 事件拦截", () => {
    const { container, onSelectEntry } = renderTimeline([
      entry("a", localIso(18, 9, 0)),
      entry("b", localIso(17, 9, 0)),
    ]);
    const dates = Array.from(
      container.querySelectorAll<HTMLElement>("[data-timeline-date]"),
    );
    // 日期行本身没有可点击语义（点它不该选中条目）
    expect(dates.every((node) => node.tagName === "DIV")).toBe(true);
    fireEvent.click(dates[0]!);
    expect(onSelectEntry).not.toHaveBeenCalled();
    // 卡片照样点得动
    fireEvent.click(container.querySelector("[data-entry-id]")!);
    expect(onSelectEntry).toHaveBeenCalledWith("a");
  });
});

describe("NotificationTimeline · 时间基准两档（26-2 重做）", () => {
  /** 同一批抓回（createdAt 同为 9-19 08:0x），发布时间散在 9-07→9-10 */
  function fetchedBatch(): Entry[] {
    return [
      entry("a", localIso(10, 9, 0), { createdAt: localIso(19, 8, 0) }),
      entry("b", localIso(8, 9, 0), { createdAt: localIso(19, 8, 2) }),
      entry("c", localIso(7, 9, 0), { createdAt: localIso(19, 8, 5) }),
    ];
  }

  it("默认 = 发布时间：不传 timeBasis 与 published 一致（升级零变化）", () => {
    const entries = fetchedBatch();
    const implicit = renderTimeline(entries, { granularity: "day" });
    const published = renderTimeline(entries, {
      granularity: "day",
      timeBasis: "published",
    });
    const datesOf = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("[data-timeline-date]")).map(
        (node) => (node as HTMLElement).dataset.timelineDate,
      );
    // 默认档按发布时间散成三天
    expect(datesOf(implicit.container)).toHaveLength(3);
    expect(datesOf(implicit.container)).toEqual(datesOf(published.container));
    implicit.unmount();
    published.unmount();
  });

  it("切抓取档：同批条目聚到抓取日（一个分隔），切回发布还原", () => {
    const entries = fetchedBatch();
    const fetched = renderTimeline(entries, {
      granularity: "day",
      timeBasis: "fetched",
    });
    const dates = Array.from(
      fetched.container.querySelectorAll<HTMLElement>("[data-timeline-date]"),
    );
    // 抓取档下三个都落在 9-19（抓取日）→ 只有一个分隔
    expect(dates).toHaveLength(1);
    fetched.unmount();
  });

  it("缺时间的条目不丢：无 publishedAt 在两档下都在轴上", () => {
    const noPublished = entry("np", localIso(19, 8, 0), {
      publishedAt: undefined,
    });
    for (const timeBasis of ["published", "fetched"] as const) {
      const view = renderTimeline([noPublished], { timeBasis });
      expect(
        view.container.querySelectorAll("[data-entry-id]"),
      ).toHaveLength(1);
      view.unmount();
    }
  });
});
