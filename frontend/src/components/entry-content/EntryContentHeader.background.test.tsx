import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryContentHeader } from "./EntryContentHeader";
import type { Entry } from "@/types/api";

/**
 * 46-x：卡片式正文 pane（内联合列）顶部「缺角」回归测试。
 *
 * 背景层带 `backdrop-blur` 时，Chromium 不会把带 backdrop-filter 的元素裁剪到祖先
 * `overflow: clip` 的圆角里，方角会盖住卡片的圆角（滚动后点开正文必现）。
 * 内联合列（sticky 模式）必须不渲染 backdrop-blur；第三栏（非 sticky）保留。
 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/useScrollToTop", () => ({ dispatchScrollToTop: vi.fn() }));
vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => [],
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

function backgroundLayer(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>(".transition-opacity");
  if (!node) throw new Error("background layer not found");
  return node;
}

afterEach(cleanup);

describe("顶栏背景层 backdrop-blur（卡片 pane 缺角）", () => {
  it("内联合列（sticky）不叠加 backdrop-blur，避免逃逸 overflow:clip 圆角", () => {
    const { container } = render(<EntryContentHeader {...baseProps} sticky />);
    expect(backgroundLayer(container).className).not.toContain("backdrop-blur");
  });

  it("第三栏（非 sticky）保留 backdrop-blur", () => {
    const { container } = render(<EntryContentHeader {...baseProps} />);
    expect(backgroundLayer(container).className).toContain("backdrop-blur-sm");
  });

  it("backgroundBlur 显式覆盖默认值", () => {
    const { container } = render(
      <EntryContentHeader {...baseProps} sticky backgroundBlur />,
    );
    expect(backgroundLayer(container).className).toContain("backdrop-blur-sm");
  });
});
