import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MobileActionSheet } from "./MobileActionSheet";

describe("MobileActionSheet", () => {
  it("底部面板挂载、动作可点、遮罩 pointerdown 关闭", () => {
    const onOpenChange = vi.fn();
    render(
      <MobileActionSheet open onOpenChange={onOpenChange} title="操作">
        <button type="button">标为已读</button>
      </MobileActionSheet>,
    );

    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("data-placement")).toBe("sheet");
    expect(panel.className).toContain("[contain:layout_paint_style]");
    expect(panel.className).toContain("[will-change:transform,opacity]");
    expect(screen.getByText("标为已读")).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId("mobile-action-sheet-backdrop"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("锚定面板按 anchor 定位并保留 contain/will-change", () => {
    render(
      <MobileActionSheet
        open
        onOpenChange={() => {}}
        title="更多"
        anchor={{ x: 200, y: 400 }}
      >
        <button type="button">复制链接</button>
      </MobileActionSheet>,
    );

    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("data-placement")).toBe("anchor");
    expect(panel.className).toContain("[contain:layout_paint_style]");
    expect(panel.className).toContain("[will-change:transform,opacity]");
  });
});
