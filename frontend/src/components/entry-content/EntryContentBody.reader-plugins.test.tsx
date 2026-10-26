import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntryContentBody } from "./EntryContentBody";
import type { PluginDecoration, PluginSelection } from "@/plugins/types";
import type { Surface } from "@/plugins/surfaces";
import type { Entry } from "@/types/api";

/**
 * 56-23：阅读器接线（装饰 + 选中事件 + `entry.reader.body` 插槽）。
 *
 * 三件事一起验：
 *   ① 条目的装饰拉回来 → 正文里出现 `<mark data-plugin>`；
 *   ② 正文里选中文字 → 正文上方的插件条出现，`selection.textRange` 是**相对正文容器**的
 *      rune 区间（不是页面坐标、不是 UTF-16 偏移）；
 *   ③ 选区清掉 → 插件条消失（没选中就不占位）；
 *   ④ 换条目 → 旧装饰还原（不残留）、新条目重新拉。
 */

const { decorationsByEntry, fetchEntryDecorations, slotProps } = vi.hoisted(
  () => ({
    decorationsByEntry: { current: {} as Record<string, PluginDecoration[]> },
    fetchEntryDecorations: vi.fn(
      (entryId: string): Promise<PluginDecoration[]> =>
        Promise.resolve(decorationsByEntry.current[entryId] ?? []),
    ),
    slotProps: { current: [] as Record<string, unknown>[] },
  }),
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useCodeHighlight", () => ({
  useCodeHighlight: vi.fn(),
}));

vi.mock("@/hooks/useEntryMeta", () => ({
  useEntryMeta: () => ({ publishedLong: null, readingTime: null }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [] }),
}));

// 正文渲染成真 HTML：装饰要落在 `<p>` 里的文本节点上，桩成纯文本就验不到位置
vi.mock("@/components/ui/article-content", () => ({
  ArticleContent: ({ content }: { content?: string }) => (
    <div dangerouslySetInnerHTML={{ __html: content ?? "" }} />
  ),
}));

vi.mock("@/plugins/api", () => ({
  fetchEntryDecorations,
}));

// 插槽桩：只把收到的 props 记下来，断言「挂了哪个 surface、带了什么选中态」
vi.mock("@/plugins/PluginSlot", () => ({
  PluginSlot: (props: {
    surface: Surface;
    variant: string;
    selection: PluginSelection;
  }) => {
    slotProps.current.push(props);
    return (
      <div
        data-testid="plugin-slot"
        data-surface={props.surface}
        data-variant={props.variant}
        data-selection={JSON.stringify(props.selection)}
      />
    );
  },
}));

function entry(id: string): Entry {
  return {
    id,
    feedId: "feed-1",
    title: "Title",
    content: "<p>Hello world</p>",
    read: true,
    starred: false,
    muted: false,
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

const CONTENT = "<p>Hello world</p>";

function renderBody(id = "entry-1") {
  return render(
    <EntryContentBody
      entry={entry(id)}
      scrollRef={vi.fn()}
      displayContent={CONTENT}
    />,
  );
}

function proseOf(container: HTMLElement): HTMLElement {
  const prose = container.querySelector<HTMLElement>(
    '[data-slot="article-prose"]',
  );
  if (!prose) throw new Error("article-prose 容器没渲染");
  return prose;
}

/** 选中正文里 [start, end) 这段（UTF-16 下标，测试里内容都是 ASCII） */
function selectInProse(prose: HTMLElement, start: number, end: number) {
  const textNode = prose.querySelector("p")?.firstChild;
  if (!textNode) throw new Error("正文里没有文本节点");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const selection = window.getSelection();
  if (!selection) throw new Error("jsdom 没有 Selection");
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function clearSelection() {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  decorationsByEntry.current = {};
  fetchEntryDecorations.mockClear();
  slotProps.current = [];
});

afterEach(() => {
  cleanup();
  clearSelection();
});

describe("EntryContentBody 接插件装饰与选中（56-23）", () => {
  it("① 有装饰 → 正文里出现 <mark data-plugin>", async () => {
    decorationsByEntry.current["entry-1"] = [
      { plugin: "annotate", id: "a1", start: 6, end: 11, style: "highlight" },
    ];

    const { container } = renderBody();

    await waitFor(() => {
      expect(
        container.querySelector('mark[data-plugin="annotate"]')?.textContent,
      ).toBe("world");
    });
    expect(fetchEntryDecorations).toHaveBeenCalledWith("entry-1");
    expect(proseOf(container).textContent).toBe("Hello world");
  });

  it("② 选中文字 → 浮动条出现，selection 带相对正文的 rune 区间", async () => {
    const { container } = renderBody();
    await waitFor(() => expect(fetchEntryDecorations).toHaveBeenCalled());

    expect(screen.queryByTestId("plugin-slot")).toBeNull();

    selectInProse(proseOf(container), 0, 5);

    const slot = await screen.findByTestId("plugin-slot");
    expect(slot.getAttribute("data-surface")).toBe("entry.reader.body");
    expect(slot.getAttribute("data-variant")).toBe("toolbar");
    expect(JSON.parse(slot.getAttribute("data-selection") ?? "{}")).toEqual({
      entryIds: ["entry-1"],
      textRange: { start: 0, end: 5, text: "Hello" },
    });
  });

  it("③ 清空选中 → 浮动条消失", async () => {
    const { container } = renderBody();
    await waitFor(() => expect(fetchEntryDecorations).toHaveBeenCalled());

    selectInProse(proseOf(container), 6, 11);
    expect(await screen.findByTestId("plugin-slot")).toBeTruthy();

    clearSelection();

    await waitFor(() => {
      expect(screen.queryByTestId("plugin-slot")).toBeNull();
    });
  });

  it("④ 切换条目 → 旧装饰还原、新条目重新拉", async () => {
    decorationsByEntry.current["entry-1"] = [
      { plugin: "annotate", id: "old", start: 6, end: 11, style: "highlight" },
    ];
    decorationsByEntry.current["entry-2"] = [
      { plugin: "annotate", id: "new", start: 0, end: 5, style: "highlight" },
    ];

    const { container, rerender } = renderBody("entry-1");
    await waitFor(() => {
      expect(
        container.querySelector('mark[data-decoration-id="old"]'),
      ).not.toBeNull();
    });

    rerender(
      <EntryContentBody
        entry={entry("entry-2")}
        scrollRef={vi.fn()}
        displayContent={CONTENT}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('mark[data-decoration-id="new"]')?.textContent,
      ).toBe("Hello");
    });
    // 旧装饰一个都不许残留（正文内容没变，不还原就会叠着）
    expect(container.querySelector('mark[data-decoration-id="old"]')).toBeNull();
    expect(container.querySelectorAll("mark[data-plugin]").length).toBe(1);
    expect(fetchEntryDecorations.mock.calls.map((call) => call[0])).toEqual([
      "entry-1",
      "entry-2",
    ]);
  });
});
