import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { NotificationTimeline } from "./NotificationTimeline";

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
});

afterEach(() => {
  vi.useRealTimers();
});

function renderTimeline(
  entries: Entry[],
  options: Partial<React.ComponentProps<typeof NotificationTimeline>> = {},
) {
  const onSelectEntry = vi.fn();
  const utils = render(
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
    />,
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
      "timeline.today",
      "timeline.yesterday",
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

  it("就地展开：摘掉 clamp，条目仍在轴上同一个节点行里（不换 DOM、不跳轴）", () => {
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

      expect(body?.style.webkitLineClamp).toBe("");
      // 轴上的位置没变：还是同一行、同一行的节点还在
      expect(body!.closest("[data-timeline-row]")).toBe(rowBefore);
      expect(rowBefore?.querySelector("[data-timeline-dot]")).not.toBeNull();
      // 展开按钮就地变成「收起」，点击不会再选中条目（不打开详情）
      expect(toggle!.textContent).toContain("timeline.collapse");
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

describe("NotificationTimeline · 与列表的契约", () => {
  it("点卡片 = 选中该条目（详情走既有的覆盖式打开，不是替换列表）", () => {
    const { container, onSelectEntry } = renderTimeline([entry("a", localIso(18, 14, 10))]);
    fireEvent.click(container.querySelector("[data-entry-id]")!);
    expect(onSelectEntry).toHaveBeenCalledWith("a");
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
