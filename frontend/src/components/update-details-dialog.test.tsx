import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { UpdateDetailsDialog } from "./update-details-dialog";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import type { UpdateCheckResult, UpdateRelease } from "@/types/settings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const extra = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",");
      return `${key}(${extra})`;
    },
  }),
}));

function release(overrides: Partial<UpdateRelease> = {}): UpdateRelease {
  const version = overrides.version ?? "v1.5.0";
  return {
    version,
    // 真实 Release 多数 name 与 tag 相同；测试里跟着 version 走，
    // 否则副标题会意外出现在每个条目上。
    name: version,
    url: `https://github.com/example/krss/releases/tag/${version}`,
    publishedAt: "2026-12-01T10:00:00Z",
    notesHtml: "<h2>1.5.0</h2><ul><li>新功能</li></ul>",
    assets: [],
    ...overrides,
  };
}

function result(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    currentVersion: "1.4.0",
    latestVersion: "v1.5.0",
    hasUpdate: true,
    releaseName: "v1.5.0",
    releaseUrl: "https://github.com/example/krss/releases/tag/v1.5.0",
    publishedAt: "2026-12-01T10:00:00Z",
    releaseNotesHtml: "<h2>1.5.0</h2><ul><li>新功能</li></ul>",
    assets: [],
    releases: [release()],
    ...overrides,
  };
}

/** 直接把 store 灌成「已查到结果 + 弹窗打开」，组件本身只读 store。 */
function openWith(payload: UpdateCheckResult) {
  useUpdateCheckStore.setState({ status: "success", result: payload });
  useUpdateCheckStore.getState().setDetailOpen(true);
  return render(<UpdateDetailsDialog />);
}

describe("UpdateDetailsDialog", () => {
  beforeEach(() => {
    useUpdateCheckStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useUpdateCheckStore.getState().reset();
  });

  it("弹窗关着时不渲染内容", () => {
    useUpdateCheckStore.setState({ status: "success", result: result() });

    render(<UpdateDetailsDialog />);

    expect(screen.queryByText("update.close")).toBeNull();
  });

  it("列出当前版本之后的所有版本，而不是只列最新一版", async () => {
    openWith(
      result({
        releases: [
          release({ version: "v1.5.0", notesHtml: "<p>最新一版</p>" }),
          release({
            version: "v1.4.2",
            url: "https://github.com/example/krss/releases/tag/v1.4.2",
            publishedAt: "2026-11-28T10:00:00Z",
            notesHtml: "<p>中间那一版</p>",
          }),
          release({
            version: "v1.4.1",
            url: "https://github.com/example/krss/releases/tag/v1.4.1",
            publishedAt: "2026-11-26T10:00:00Z",
            notesHtml: "<p>最早那一版</p>",
          }),
        ],
      }),
    );

    expect(await screen.findByText("v1.5.0")).toBeTruthy();
    expect(screen.getByText("v1.4.2")).toBeTruthy();
    expect(screen.getByText("v1.4.1")).toBeTruthy();
    // 多版时标题用数量口径，不能谎报「只有最新一版有更新」
    expect(screen.getByText("update.details_title_count(count=3)")).toBeTruthy();
    expect(screen.getByText("update.details_since(version=1.4.0)")).toBeTruthy();
  });

  it("默认展开最新一版，其余折叠", async () => {
    openWith(
      result({
        releases: [
          release({ version: "v1.5.0", notesHtml: "<p>最新一版</p>" }),
          release({ version: "v1.4.2", notesHtml: "<p>中间那一版</p>" }),
        ],
      }),
    );

    // 面板内容一直在 DOM 里（靠高度动画收起），所以断言 aria-expanded 而不是可见性
    const triggers = await screen.findAllByRole("button", { expanded: true });
    expect(triggers.length).toBe(1);
    expect(triggers[0]?.textContent).toContain("v1.5.0");

    fireEvent.click(screen.getByText("v1.4.2"));

    await waitFor(() =>
      expect(screen.getAllByRole("button", { expanded: true }).length).toBe(2),
    );
  });

  it("只有一版时标题沿用版本号口径", async () => {
    openWith(result());

    expect(
      await screen.findByText("update.details_title(version=v1.5.0)"),
    ).toBeTruthy();
  });

  it("没有发布说明时显示 no_notes", async () => {
    openWith(result({ releases: [release({ notesHtml: "" })] }));

    expect(await screen.findByText("update.no_notes")).toBeTruthy();
  });

  it("有附件时列出文件名与大小，size 0 不显示大小", async () => {
    openWith(
      result({
        releases: [
          release({
            assets: [
              {
                name: "krss-linux-amd64",
                url: "https://example.com/dl/linux",
                size: 12345678,
              },
              {
                name: "krss-windows-amd64.exe",
                url: "https://example.com/dl/windows",
                size: 0,
              },
            ],
          }),
        ],
      }),
    );

    expect(await screen.findByText("update.downloads")).toBeTruthy();
    expect(screen.getByText("krss-linux-amd64")).toBeTruthy();
    expect(screen.getByText("12 MB")).toBeTruthy();
    expect(screen.getByText("krss-windows-amd64.exe")).toBeTruthy();
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("发布说明里的链接一律开新标签（否则会把 SPA 导航走）", async () => {
    openWith(
      result({
        releases: [
          release({
            notesHtml:
              '<p>看看<a href="https://github.com/example/krss/compare/v1.4.0...v1.5.0">完整改动</a>。</p>',
          }),
        ],
      }),
    );

    const link = await screen.findByText("完整改动");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("publishedAt 非法不崩（原样渲染）", async () => {
    openWith(result({ releases: [release({ publishedAt: "not-a-date" })] }));

    expect(await screen.findByText(/not-a-date/)).toBeTruthy();
  });

  it("点「关闭」收起弹窗", async () => {
    openWith(result());

    fireEvent.click(await screen.findByText("update.close"));

    expect(useUpdateCheckStore.getState().detailOpen).toBe(false);
  });
});
