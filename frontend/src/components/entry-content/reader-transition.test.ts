import { describe, expect, it } from "vitest";
import {
  PUSH_ANIMATE,
  PUSH_EXIT_WITH_ENTRY,
  PUSH_INITIAL,
  PUSH_TRANSITION,
  SLIDE_ANIMATE,
  SLIDE_ANIMATE_OPACITY_DELAY,
  SLIDE_EXIT,
  SLIDE_INITIAL,
  SLIDE_TRANSITION,
  pushPaneKey,
  resolveReaderTransition,
  slideContentKey,
} from "./reader-transition";

describe("第三栏转场触发条件（对齐 Nextflux ArticleView.jsx）", () => {
  it("还没选过任何条目时点第一条 → 推进（push）", () => {
    expect(resolveReaderTransition(null, "entry-1")).toBe("push");
    expect(pushPaneKey(null)).toBe("empty");
    expect(pushPaneKey("entry-1")).toBe("content");
  });

  it("已选中某条后再点另一条 → 上下滑动（slide）", () => {
    expect(resolveReaderTransition("entry-1", "entry-2")).toBe("slide");
    // 外层 key 不动（都是 content），只有内层 key 换 → 不触发推进
    expect(pushPaneKey("entry-1")).toBe(pushPaneKey("entry-2"));
    expect(slideContentKey("entry-1")).not.toBe(slideContentKey("entry-2"));
  });

  it("同 id 重复选中 / 都没选中 → 无转场", () => {
    expect(resolveReaderTransition("entry-1", "entry-1")).toBe("none");
    expect(resolveReaderTransition(null, null)).toBe("none");
  });

  it("关闭（有值 → null）→ close", () => {
    expect(resolveReaderTransition("entry-1", null)).toBe("close");
  });

  it("数值与 Nextflux 原件一致（ArticleView.jsx L155-202）", () => {
    // 外层推进 L155-159 / L160 / L161-167 / L168-173
    expect(PUSH_INITIAL).toEqual({ opacity: 1, x: "100vw" });
    expect(PUSH_ANIMATE).toEqual({ opacity: 1, x: 0, scale: 1 });
    expect(PUSH_EXIT_WITH_ENTRY).toEqual({ opacity: 1, x: "100vw", scale: 1 });
    expect(PUSH_TRANSITION).toEqual({
      duration: 0.5,
      type: "spring",
      bounce: 0,
      ease: "easeInOut",
    });
    // 内层滑动 L193 / L194-200 / L201 / L202（无方向反转：进 +50，出 -50）
    expect(SLIDE_INITIAL).toEqual({ y: 50, opacity: 0 });
    expect(SLIDE_ANIMATE).toEqual({ y: 0, opacity: 1 });
    expect(SLIDE_ANIMATE_OPACITY_DELAY).toBe(0.05);
    expect(SLIDE_EXIT).toEqual({ y: -50, opacity: 0 });
    expect(SLIDE_TRANSITION).toEqual({ bounce: 0, ease: "easeInOut" });
  });
});
