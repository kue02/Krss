import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryContentHeader } from "./EntryContentHeader";
import type { PluginContribution } from "@/plugins/types";
import type { Entry } from "@/types/api";

/**
 * 56-15：阅读器工具栏接插件插槽（`surface="entry.reader.toolbar"`）；
 * 56-16：同一工具栏上的星标按钮是**可被插件顶掉**的宿主控件（`target="entry.star"`）。
 *
 * 选中态就是当前正在读的这一条（`entry.id`，前端本来就是字符串，不走 `Number()`
 * —— 56-12 已经把这个口径改正，19 位 id 转数字会丢精度）。
 */
const { contributions } = vi.hoisted(() => ({
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => contributions.current,
}));

vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "Entry title",
  content: "<p>body</p>",
  read: false,
  starred: false,
  muted: false,
  publishedAt: "2024-01-01T09:00:00.000Z",
  createdAt: "2024-01-01T09:00:00.000Z",
  updatedAt: "2024-01-01T09:00:00.000Z",
};

const baseProps = {
  entry,
  isAtTop: false,
  isReadableActive: false,
  isLoading: false,
  error: null,
  onToggleReadable: vi.fn(),
  onToggleStarred: vi.fn(),
};

function readerContribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "push-one",
    surface: "entry.reader.toolbar",
    action: "notify",
    label: "推送这篇（Bark）",
    selection: "single",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  contributions.current = [];
});

describe("EntryContentHeader 的插件插槽（56-15）", () => {
  it("① 挂点上有贡献 → 工具栏末尾多一个按钮（single 选中正好一条）", () => {
    contributions.current = [readerContribution()];
    render(<EntryContentHeader {...baseProps} />);

    expect(screen.getByText("推送这篇（Bark）")).toBeTruthy();
    // 宿主既有的星标按钮仍在
    expect(screen.getByTitle("entry.add_to_starred")).toBeTruthy();
  });

  it("② 挂点上没有贡献 → 不渲染、不崩", () => {
    contributions.current = [];
    const { container } = render(<EntryContentHeader {...baseProps} />);

    expect(screen.queryByText("推送这篇（Bark）")).toBeNull();
    expect(container.textContent).toContain("Entry title");
  });
});
