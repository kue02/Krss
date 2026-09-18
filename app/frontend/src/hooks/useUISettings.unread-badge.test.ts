import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UNREAD_BADGE,
  getUISettings,
  setUISetting,
} from "./useUISettings";

/**
 * 13-3：真机点「未读数」后 `localStorage["gist-ui-settings"].unreadBadge` 仍是 undefined，
 * 但组件单测证明「点击 → setUnreadBadge」是通的 —— 所以这里把 store 这一层单独钉住。
 */
afterEach(() => {
  localStorage.removeItem("gist-ui-settings");
});

describe("unreadBadge 落盘（13-3）", () => {
  it("setUISetting 写进 localStorage 并能读回", () => {
    setUISetting("unreadBadge", { ...DEFAULT_UNREAD_BADGE, content: "count" });
    expect(getUISettings().unreadBadge.content).toBe("count");

    const raw = JSON.parse(localStorage.getItem("gist-ui-settings") || "{}");
    expect(raw.unreadBadge?.content).toBe("count");
  });

  it("默认值存在（老库没有这个键时用它兜底）", () => {
    expect(DEFAULT_UNREAD_BADGE.content).toBe("dot");
    expect(DEFAULT_UNREAD_BADGE.placement).toBe("top-left");
    expect(DEFAULT_UNREAD_BADGE.size).toBe(8);
  });
});
