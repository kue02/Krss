import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FilterRule } from "@/types/filters";

/**
 * 13-2（效果图 revert-impact.html）：一条内容就一行 ——
 * 勾选框固定 16px 在左、垂直居中；整行可点；**标题占弹性宽度**（超长才滚）；
 * **来源 + 状态是 Content 之外的 shrink-0 右尾**（不再把标题挤成 91px、让跑马灯失效）；
 * 行高统一 38px（星标那行 32px）。
 */
const { getFilterImpact } = vi.hoisted(() => ({ getFilterImpact: vi.fn() }));

vi.mock("@/api", async () => {
  const actual = await vi.importActual<typeof import("@/api")>("@/api");
  return { ...actual, getFilterImpact, revertFilter: vi.fn() };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RevertFilterDialog } from "./RevertFilterDialog";

const rule = { id: "r1", name: "test", kind: "rule" } as unknown as FilterRule;

afterEach(() => {
  cleanup();
  getFilterImpact.mockReset();
});

describe("撤销影响列表（13-2）", () => {
  it("一行到底：行高 38px、标题弹性、来源+状态是 Content 之外的 shrink-0 右尾", async () => {
    getFilterImpact.mockResolvedValue({
      items: [
        {
          entryId: "e1",
          title: "这是一条很长的条目标题，用来验证跑马灯与弹性宽度",
          feedTitle: "小众软件",
          publishedAt: "2026-09-18T04:00:00Z",
          muted: true,
          starred: false,
          read: false,
          actions: { mute: true, star: false },
        },
        {
          entryId: "e2",
          title: "短标题",
          feedTitle: "少数派",
          publishedAt: "2026-09-18T04:00:00Z",
          muted: false,
          starred: true,
          read: true,
          actions: { star: true },
        },
      ],
    });

    render(<RevertFilterDialog rule={rule} onClose={() => {}} />);
    await screen.findByText("短标题", { exact: false });

    const rows = [...document.querySelectorAll('[data-slot="checkbox"]')];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const row = rows[0]!;
    // 行高统一 38px（效果图「行高 38px」）
    expect(row.className).toContain("h-[38px]");
    // **flex-row 是硬要求**：HeroUI 的 `.checkbox` 在组件层写死了 flex-direction:column，
    // 不顶掉它就会「勾选框一行、标题一行、来源一行」三条叠起来（真机量过：勾选框 y=416、
    // 标题 y=440、右尾 y=468，标题只剩 95px ⇒ 跑马灯失效）。jsdom 不加载样式表，
    // 这条断言只盯「类名还在不在」，别删。
    expect(row.className).toContain("flex-row");

    const content = row.querySelector('[data-slot="checkbox-content"]');
    expect(content).not.toBeNull();
    // 标题占弹性宽度、可收缩（跑马灯才量得出距离）
    expect(content!.className).toContain("min-w-0");
    expect(content!.className).toContain("flex-1");
    // 跑马灯在 Content 里
    expect(content!.querySelector(".marquee, [class*='marquee']")).not.toBeNull();

    // 右尾：行内最后一个元素，且**不在** Content 里（这就是 13-2 的关键结构）
    const tail = row.lastElementChild as HTMLElement;
    expect(tail).not.toBe(content);
    expect(tail.className).toContain("shrink-0");
    expect(tail.textContent).toContain("小众软件");
    // 状态标记也在右尾
    expect(tail.textContent).toContain("automation.revert_flag_muted");
  });
});
