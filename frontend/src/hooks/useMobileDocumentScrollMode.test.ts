import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileDocumentScrollMode } from "./useMobileDocumentScrollMode";

describe("useMobileDocumentScrollMode", () => {
  const originalScrollRestoration = history.scrollRestoration;

  beforeEach(() => {
    document.documentElement.className = "";
    document.body.className = "";
    // 预置成 "manual"，用来验证 hook 会把它改回 "auto"（iOS 返回手势预览
    // 空白问题，见 useMobileDocumentScrollMode.ts 注释）。
    history.scrollRestoration = "manual";
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 240,
    });
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    document.documentElement.className = "";
    document.body.className = "";
    history.scrollRestoration = originalScrollRestoration;
    vi.restoreAllMocks();
  });

  it("enables document scrolling and browser-native (auto) scroll restoration", () => {
    const { unmount } = renderHook(() =>
      useMobileDocumentScrollMode({ enabled: true, locked: false }),
    );

    expect(document.documentElement.classList).toContain(
      "mobile-document-scroll",
    );
    expect(document.body.classList).toContain("mobile-document-scroll");
    // 关键：从 "manual" 切到 "auto"，让 iOS 返回手势有快照可用（不空白）。
    expect(history.scrollRestoration).toBe("auto");

    unmount();

    expect(document.documentElement.classList).not.toContain(
      "mobile-document-scroll",
    );
    // 卸载后恢复调用前的值（beforeEach 预置的 "manual"）。
    expect(history.scrollRestoration).toBe("manual");
  });

  it("locks overlays without losing the list position", () => {
    const { rerender } = renderHook(
      ({ locked }: { locked: boolean }) =>
        useMobileDocumentScrollMode({ enabled: true, locked }),
      { initialProps: { locked: false } },
    );

    rerender({ locked: true });
    expect(document.documentElement.classList).toContain(
      "mobile-document-scroll-locked",
    );

    act(() => rerender({ locked: false }));

    expect(document.documentElement.classList).not.toContain(
      "mobile-document-scroll-locked",
    );
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 240,
      behavior: "auto",
    });
  });

  it("leaves global scrolling unchanged when disabled", () => {
    renderHook(() =>
      useMobileDocumentScrollMode({ enabled: false, locked: false }),
    );

    expect(document.documentElement.className).toBe("");
    expect(document.body.className).toBe("");
    // 禁用时不动 scrollRestoration，保持调用前的值。
    expect(history.scrollRestoration).toBe("manual");
  });
});
