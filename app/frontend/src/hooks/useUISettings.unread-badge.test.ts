import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UNREAD_BADGE,
  getUISettings,
  setUISetting,
} from "./useUISettings";
import { LS_KEYS } from "@/lib/settings-storage";

/**
 * 13-3：真机点「未读数」后 `localStorage` 里读不到 `unreadBadge`，但组件单测证明
 * 「点击 → setUnreadBadge」是通的 —— 所以这里把 store 这一层单独钉住。
 *
 * 21 批（2026-09-18）改了落盘格式，这条用例跟着改了两处断言：
 *   1. 键名 `krss-ui-settings`；
 *   2. 值不再是扁平一坨，而是 `{ shared, device: { desktop, mobile } }` ——
 *      `unreadBadge` 不是尺寸类，落在 `shared` 里；尺寸类（列宽 / 缩放 / 侧栏）按设备分套。
 */
afterEach(() => {
  localStorage.removeItem(LS_KEYS.uiSettings.key);
});

describe("unreadBadge 落盘（13-3）", () => {
  it("setUISetting 写进 localStorage 并能读回", () => {
    setUISetting("unreadBadge", { ...DEFAULT_UNREAD_BADGE, content: "count" });
    expect(getUISettings().unreadBadge.content).toBe("count");

    const raw = JSON.parse(
      localStorage.getItem(LS_KEYS.uiSettings.key) || "{}",
    ) as {
      shared?: { unreadBadge?: { content?: string } };
      device?: { desktop?: Record<string, unknown> };
    };
    expect(raw.shared?.unreadBadge?.content).toBe("count");
    // 非尺寸类不许落到设备档里
    expect(raw.device?.desktop?.unreadBadge).toBeUndefined();
  });

  it("默认值存在（老库没有这个键时用它兜底）", () => {
    expect(DEFAULT_UNREAD_BADGE.content).toBe("dot");
    expect(DEFAULT_UNREAD_BADGE.placement).toBe("top-left");
    expect(DEFAULT_UNREAD_BADGE.size).toBe(8);
  });
});
