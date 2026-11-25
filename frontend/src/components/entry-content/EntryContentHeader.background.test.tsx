import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryContentHeader } from "./EntryContentHeader";
import type { Entry } from "@/types/api";

/**
 * 46-x：卡片式正文 pane（内联合列）顶部「缺角」回归测试。
 *
 * 背景层带 `backdrop-filter` 时，Chromium 不会把该元素裁剪到祖先 `overflow: clip`
 * 的圆角里；现在的解法是**保留模糊、让模糊层自带 12px 顶部圆角**（见下方用例），
 * 不再靠关掉模糊。这里同时保留组件默认值用例：未显式传 `backgroundBlur` 时 sticky
 * 仍按保守默认关模糊，真正走 App 的卡片档会显式传 true + `backgroundTopRadius`。
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
  it("未显式传 backgroundBlur 时（组件兜底默认）sticky 不叠加 backdrop-blur", () => {
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

describe("手机内联合列工具栏背景层 backdrop-blur", () => {
  it("显式 backgroundBlur=false 时不叠加 backdrop-blur-xl", () => {
    const { container } = render(
      <EntryContentHeader
        {...baseProps}
        isMobile
        sticky
        mobileInlineSticky
        backgroundBlur={false}
      />,
    );
    const cls = backgroundLayer(container).className;
    expect(cls).not.toContain("backdrop-blur");
    expect(cls).toContain("bg-overlay/80");
  });

  it("原样档（backgroundBlur=true）保留 backdrop-blur-xl", () => {
    const { container } = render(
      <EntryContentHeader
        {...baseProps}
        isMobile
        sticky
        mobileInlineSticky
        backgroundBlur
      />,
    );
    expect(backgroundLayer(container).className).toContain("backdrop-blur-xl");
  });

  it("手机第三栏（非 sticky，默认值）保留模糊", () => {
    const { container } = render(<EntryContentHeader {...baseProps} isMobile />);
    expect(backgroundLayer(container).className).toContain("backdrop-blur-xl");
  });
});

describe("磨砂层自带顶部圆角（卡片 pane 缺角的最小改法）", () => {
  it("桌面：backgroundTopRadius=true 时给背景层加 rounded-t-[12px]", () => {
    const { container } = render(
      <EntryContentHeader {...baseProps} sticky backgroundBlur backgroundTopRadius />,
    );
    expect(backgroundLayer(container).className).toContain("rounded-t-[12px]");
  });

  it("桌面：默认不给背景层加圆角", () => {
    const { container } = render(<EntryContentHeader {...baseProps} sticky backgroundBlur />);
    expect(backgroundLayer(container).className).not.toContain("rounded-t-[12px]");
  });

  it("手机：backgroundTopRadius=true 时同样加 rounded-t-[12px]", () => {
    const { container } = render(
      <EntryContentHeader
        {...baseProps}
        isMobile
        sticky
        mobileInlineSticky
        backgroundBlur
        backgroundTopRadius
      />,
    );
    expect(backgroundLayer(container).className).toContain("rounded-t-[12px]");
  });
});
