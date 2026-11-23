import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EntryContentHeader } from "./EntryContentHeader";
import type { Entry } from "@/types/api";

/**
 * 问题③：正文页顶栏的摘要 / 翻译按钮悬浮文案（Tooltip）与列表徽章同口径。
 * 这里验证文案选择：完成态显示 provider · model（或 service），失败态显示错误原因。
 * Tooltip 未悬浮时正文不挂载，但 button 的 `aria-label` 用的就是同一份 Tooltip 文案，
 * 因此直接断言 aria-label 即可稳定覆盖「文案选择」逻辑（不再用原生 title，避免和 HeroUI Tooltip 双弹）。
 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

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

function renderHeader(props: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <EntryContentHeader {...baseProps} {...props} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("EntryContentHeader 顶栏按钮 Tooltip 文案（问题③）", () => {
  it("摘要完成态显示 provider · model", () => {
    const { container } = renderHeader({
      hasSummary: true,
      onToggleSummary: vi.fn(),
      summaryUsage: { provider: "OpenAI", model: "gpt-4o" },
    });
    expect(
      container.querySelector('button[aria-label="OpenAI · gpt-4o"]'),
    ).not.toBeNull();
  });

  it("摘要无 usage 时退回动作文案", () => {
    const { container } = renderHeader({
      hasSummary: true,
      onToggleSummary: vi.fn(),
    });
    expect(
      container.querySelector('button[aria-label="entry.hide_summary"]'),
    ).not.toBeNull();
  });

  it("摘要失败态显示错误原因", () => {
    const { container } = renderHeader({
      hasSummary: false,
      onToggleSummary: vi.fn(),
      summaryError: "summary boom",
    });
    expect(
      container.querySelector('button[aria-label="summary boom"]'),
    ).not.toBeNull();
  });

  it("翻译完成态仅有 service 时显示 service", () => {
    const { container } = renderHeader({
      hasSummary: false,
      onToggleSummary: vi.fn(),
      hasTranslation: true,
      onToggleTranslation: vi.fn(),
      translationUsage: { service: "Google" },
    });
    expect(
      container.querySelector('button[aria-label="Google"]'),
    ).not.toBeNull();
  });

  it("翻译失败态显示错误原因", () => {
    const { container } = renderHeader({
      hasSummary: false,
      onToggleSummary: vi.fn(),
      hasTranslation: false,
      onToggleTranslation: vi.fn(),
      translationError: "translate boom",
    });
    expect(
      container.querySelector('button[aria-label="translate boom"]'),
    ).not.toBeNull();
  });
});
