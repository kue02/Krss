import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryContentHeader } from "./EntryContentHeader";
import type { PluginContribution } from "@/plugins/types";
import type { Entry } from "@/types/api";

/**
 * 56-16：受控 patch 落到阅读器工具栏的星标按钮上。
 *
 * `entry.star` 是宿主登记为**可替换**（也可隐藏）的控件：`op:"replace"` 时点击行为交给
 * 插件动作（渲染成插件项），`op:"hide"` 时整颗按钮不渲染。两者都不生效时照旧是宿主的星标。
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

function contribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "star-via-api",
    surface: "entry.reader.toolbar",
    action: "star",
    label: "星标到稍后读",
    selection: "single",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  contributions.current = [];
});

describe("阅读器工具栏的星标受控 patch（56-16）", () => {
  it("① op:\"replace\" → 星标按钮换成插件项（原按钮不再渲染）", () => {
    contributions.current = [
      contribution({ op: "replace", target: "entry.star" }),
    ];
    render(<EntryContentHeader {...baseProps} />);

    expect(screen.getByText("星标到稍后读")).toBeTruthy();
    expect(screen.queryByTitle("entry.add_to_starred")).toBeNull();
  });

  it("② op:\"hide\" → 星标按钮不渲染（也不冒出一项）", () => {
    contributions.current = [
      contribution({ op: "hide", target: "entry.star" }),
    ];
    render(<EntryContentHeader {...baseProps} />);

    expect(screen.queryByTitle("entry.add_to_starred")).toBeNull();
    expect(screen.queryByText("星标到稍后读")).toBeNull();
  });

  it("③ 没有 patch 贡献 → 宿主星标照旧（默认行为不变）", () => {
    contributions.current = [];
    render(<EntryContentHeader {...baseProps} />);

    expect(screen.getByTitle("entry.add_to_starred")).toBeTruthy();
  });

  it("④ op:\"replace\" 指向不可替换的目标（entry.mark_read）→ 星标照旧、也不冒插件项", () => {
    contributions.current = [
      contribution({ op: "replace", target: "entry.mark_read" }),
    ];
    render(<EntryContentHeader {...baseProps} />);

    expect(screen.getByTitle("entry.add_to_starred")).toBeTruthy();
    expect(screen.queryByText("星标到稍后读")).toBeNull();
  });
});
