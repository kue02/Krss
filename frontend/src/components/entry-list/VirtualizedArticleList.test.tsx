import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";
import { VirtualizedArticleList } from "./VirtualizedArticleList";
import type { VirtualizedArticleListState } from "./useVirtualizedArticleList";

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({ id: `e${index}` }) as Entry);
}

/** range 为空（jsdom 无尺寸 / 真实浏览器首帧）时的回退状态 */
function emptyRangeState(): VirtualizedArticleListState {
  return {
    virtualizer: null,
    windowVirtualizer: {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measureElement: vi.fn(),
    } as unknown as VirtualizedArticleListState["windowVirtualizer"],
    spacers: new WeakMap(),
  };
}

describe("VirtualizedArticleList fallback", () => {
  it("range 为空且列表很长时只渲染前 12 行，不把大列表全量挂载", () => {
    render(
      <VirtualizedArticleList
        virtualList={emptyRangeState()}
        entries={makeEntries(50)}
        renderItem={(entry) => <div data-testid="row">{entry.id}</div>}
      />,
    );
    expect(screen.getAllByTestId("row")).toHaveLength(12);
  });

  it("小列表 range 为空时保持全量渲染（jsdom 既有语义）", () => {
    render(
      <VirtualizedArticleList
        virtualList={emptyRangeState()}
        entries={makeEntries(5)}
        renderItem={(entry) => <div data-testid="row">{entry.id}</div>}
      />,
    );
    expect(screen.getAllByTestId("row")).toHaveLength(5);
  });
});
