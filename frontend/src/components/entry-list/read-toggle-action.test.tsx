import { describe, expect, it } from "vitest";
import { CheckCircleIcon, CircleOutlineIcon } from "@/components/ui/icons";
import { readToggleAction } from "./read-toggle-action";

/**
 * 23-2：「标为已读 / 标为未读」三处入口共用同一份定义。
 * 这里钉住「状态 → 动作」的映射，图标与文案在三处不会漂成两样。
 */
describe("readToggleAction", () => {
  it("未读条目 → 动作是「标为已读」（对勾圆）", () => {
    const action = readToggleAction(true);
    expect(action.nextRead).toBe(true);
    expect(action.labelKey).toBe("entry.mark_read");
    expect(action.Icon).toBe(CheckCircleIcon);
  });

  it("已读条目 → 动作是「标为未读」（描边圆）", () => {
    const action = readToggleAction(false);
    expect(action.nextRead).toBe(false);
    expect(action.labelKey).toBe("entry.mark_unread");
    expect(action.Icon).toBe(CircleOutlineIcon);
  });

  it("两档图标不同（否则三处入口看不出区别）", () => {
    expect(readToggleAction(true).Icon).not.toBe(readToggleAction(false).Icon);
  });
});
