import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutoRefreshHistorySection } from "./AutoRefreshHistorySection";
import { refreshFeeds } from "@/api";
import { copyToClipboard } from "@/stores/toast-store";

/** 只回 key（带插值参数，方便断言 count），不拉 i18n 资源 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@/api", () => ({
  refreshFeeds: vi.fn(async () => undefined),
}));

vi.mock("@/stores/toast-store", () => ({
  showToast: vi.fn(),
  copyToClipboard: vi.fn(async () => true),
}));

const STORAGE_KEY = "krss-auto-refresh-history";

const FAILED_RECORD = {
  at: new Date().toISOString(),
  newCount: 0,
  updatedCount: 731,
  failedCount: 3,
  results: [
    { feedId: "f1", title: "小声逼逼 - Telegram Channel", new: 0, updated: 120 },
    { feedId: "f2", title: "少数派", new: 0, updated: 0, error: "HTTP 502" },
    {
      feedId: "f3",
      title: "即刻精选 - Telegram 频道",
      new: 0,
      updated: 0,
      error: "HTTP 502",
    },
    {
      feedId: "f4",
      title: "Twitter @歸藏",
      new: 0,
      updated: 0,
      error: "timeout（15s）这是很长的一条原因用来验证跑马灯",
    },
  ],
};

const OK_RECORD = {
  at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  newCount: 1,
  updatedCount: 772,
  failedCount: 0,
  results: [
    { feedId: "f9", title: "阮一峰的网络日志", new: 1, updated: 12 },
  ],
};

/** 重试按钮会 invalidate 刷新状态查询，所以要有 QueryClient 上下文 */
function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutoRefreshHistorySection />
    </QueryClientProvider>,
  );
}

function seed(records: unknown[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function triggers(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-slot="disclosure-trigger"]'),
  ];
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(refreshFeeds).mockClear();
  vi.mocked(copyToClipboard).mockClear();
  seed([FAILED_RECORD, OK_RECORD]);
});

describe("AutoRefreshHistorySection（第十九批重做）", () => {
  it("19-1 行拆列：时间 / 三个数字 / 状态 / 展开箭头各占一列，数字等宽", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    for (const trigger of triggers()) {
      // 四列：时间（固定宽）/ 三个数字（弹性）/ 状态（固定宽）/ 展开箭头
      const cols = [...trigger.children];
      const cls = (el: Element) => el.getAttribute("class") ?? "";
      const timeCol = cols.find((el) => cls(el).includes("w-[7.5rem]"));
      // 状态列必须是固定宽：跟着内容走的话，「有状态标」与「没状态标」的行
      // 中列宽度不同 → 三个数字会左右跳（真机实测 456px / 518px 两种值）
      const statusCol = cols.find((el) => cls(el).includes("w-[4.5rem]"));
      const statsCol = cols.find((el) => cls(el).includes("grid-cols-3"));
      const indicator = cols.find(
        (el) => el.getAttribute("data-slot") === "disclosure-indicator",
      );
      expect(timeCol).toBeTruthy();
      expect(statusCol).toBeTruthy();
      expect(indicator).toBeTruthy();
      expect(cls(statsCol as Element)).toContain("flex-1");
      // 顺序：时间 → 数字 → 状态 → 箭头
      expect(
        (timeCol as Element).compareDocumentPosition(statsCol as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        (statsCol as Element).compareDocumentPosition(statusCol as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        (statusCol as Element).compareDocumentPosition(indicator as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    const first = triggers()[0];
    if (!first) throw new Error("没有渲染出历史行");
    // 三个数字各自一颗 Chip 排在「数字」那一列的网格里（另有一颗是状态列）
    const statsGrid = first.querySelector(".grid-cols-3");
    const statChips = statsGrid?.querySelectorAll('[data-slot="chip"]') ?? [];
    expect(statChips).toHaveLength(3);
    expect(first.querySelectorAll("b.tabular-nums")).toHaveLength(3);
    expect(first.querySelectorAll("b.tabular-nums")[0]?.textContent).toBe("0");
    expect(first.querySelectorAll("b.tabular-nums")[1]?.textContent).toBe("731");
    expect(first.querySelectorAll("b.tabular-nums")[2]?.textContent).toBe("3");
    // 展开箭头在最后一列
    expect(first.querySelector('[data-slot="disclosure-indicator"]')).toBeTruthy();
  });

  it("19-2 失败行带红条 + 红数字；全成功那行给「全部成功」灰标作对照", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    const [failedRow, okRow] = triggers();
    if (!failedRow || !okRow) throw new Error("没有渲染出两行");

    // 红条（inset-y-2 的 3px 竖条）+ 失败数字是红字
    const bar = failedRow.querySelector('span[aria-hidden="true"]');
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("bg-destructive");
    expect(failedRow.className).toContain("border-destructive/40");
    expect(failedRow.querySelector("b.text-destructive")?.textContent).toBe("3");

    // 全成功那行：没有红条、有灰标
    expect(okRow.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(okRow.textContent).toContain("settings.auto_refresh_history_all_ok");
  });

  it("19-4 顶部筛选：全部 / 只看失败", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    fireEvent.click(
      screen.getByText("settings.auto_refresh_history_filter_failed"),
    );
    await waitFor(() => expect(triggers()).toHaveLength(1));
    expect(document.body.textContent).not.toContain(
      "settings.auto_refresh_history_all_ok",
    );

    fireEvent.click(screen.getByText("settings.auto_refresh_history_filter_all"));
    await waitFor(() => expect(triggers()).toHaveLength(2));
  });

  it("19-3 展开后失败置顶、按原因分组、可复制、可直接重试这 N 个源", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    const first = triggers()[0];
    if (!first) throw new Error("没有渲染出历史行");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");

    // 同一个原因只出现一次（"HTTP 502" 命中 2 个源 → 合并成一组）
    const reasonMatches = screen.getAllByText("HTTP 502");
    expect(reasonMatches).toHaveLength(1);

    // 分组块 = 原因行的爷爷（原因 span → 跑马灯 span → 原因行 → 分组块）
    const group = reasonMatches[0]?.parentElement?.parentElement?.parentElement;
    expect(group?.textContent).toContain("2");
    expect(group?.textContent).toContain("少数派");
    expect(group?.textContent).toContain("即刻精选 - Telegram 频道");

    // 失败置顶：失败原因在成功项之前（用 DOM 顺序判，不靠视觉）
    const successLine = screen.getByText("小声逼逼 - Telegram Channel");
    const reasonEl = reasonMatches[0];
    if (!reasonEl) throw new Error("没有渲染出失败原因");
    expect(
      reasonEl.compareDocumentPosition(successLine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 复制这条原因 / 复制全部失败原因 / 重试
    expect(
      document.querySelector(
        'button[aria-label="settings.auto_refresh_history_copy_reason"]',
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByText("settings.auto_refresh_history_copy_all_reasons"),
    );
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
    expect(vi.mocked(copyToClipboard).mock.calls[0]?.[0]).toContain(
      "少数派: HTTP 502",
    );

    fireEvent.click(
      screen.getByText('settings.auto_refresh_history_retry|{"count":3}'),
    );
    await waitFor(() => expect(refreshFeeds).toHaveBeenCalledTimes(1));
    expect(vi.mocked(refreshFeeds).mock.calls[0]?.[0]).toEqual([
      "f2",
      "f3",
      "f4",
    ]);
  });

  it("19-5 列表固定最大高度、内部滚动（用 HeroUI ScrollShadow 当滚动容器）", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    const scroller = document.querySelector('[data-slot="scroll-shadow"]');
    expect(scroller).toBeTruthy();
    expect(scroller?.className).toContain("max-h-[232px]");
    // 20 行都在同一个滚动区里（不是每行一个）
    expect(scroller?.querySelectorAll('[data-slot="disclosure"]')).toHaveLength(2);
  });

  it("19-6 清空走 HeroUI AlertDialog 二次确认，确认后才真清", async () => {
    renderSection();
    await waitFor(() => expect(triggers()).toHaveLength(2));

    // 打开确认框：这一步不删数据
    fireEvent.click(screen.getByText("settings.auto_refresh_history_clear"));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // 点「取消」：还是没删
    fireEvent.click(screen.getByText("actions.cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // 再打开并确认：真清掉，并回到空态
    fireEvent.click(screen.getByText("settings.auto_refresh_history_clear"));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    const dialog = screen.getByRole("alertdialog");
    // 按文案取确认键（CloseTrigger 的 X 也在这个弹框里，按 DOM 顺序取最后一个会取错）
    const confirm = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("settings.auto_refresh_history_clear"),
    );
    if (!confirm) throw new Error("确认框里没有确认按钮");
    fireEvent.click(confirm);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByText("settings.auto_refresh_history_empty"),
      ).toBeTruthy(),
    );
  });
});
