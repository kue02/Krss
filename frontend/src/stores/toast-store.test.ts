import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard, useToasts } from "./toast-store";

/**
 * 25-1 回归：普通用户用 `http://<NAS-IP>:8080`（**非安全上下文**）访问自建实例时，
 * 浏览器不提供 `navigator.clipboard` —— 复制必须退回 `execCommand("copy")` 兜底，
 * 而不是抛 TypeError 后只剩一句「复制失败」。
 *
 * 起点就按真实情况设：`navigator.clipboard` 为 undefined（jsdom 默认也没有）。
 */
describe("toast-store · copyToClipboard（25-1）", () => {
  const originalExecCommand = document.execCommand;

  /** 覆盖 document.execCommand（jsdom 自带的那个只会返回 false） */
  function mockExecCommand(result: boolean) {
    const spy = vi.fn(() => result);
    Object.defineProperty(document, "execCommand", {
      value: spy,
      configurable: true,
      writable: true,
    });
    return spy;
  }

  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", {
      value,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    setClipboard(undefined);
  });

  afterEach(() => {
    Object.defineProperty(document, "execCommand", {
      value: originalExecCommand,
      configurable: true,
      writable: true,
    });
    setClipboard(undefined);
    vi.restoreAllMocks();
  });

  it("http 入口（没有 clipboard）走 execCommand 兜底，照样算成功", async () => {
    const execCommand = mockExecCommand(true);
    const { result } = renderHook(() => useToasts());

    let ok = false;
    await act(async () => {
      ok = await copyToClipboard("https://example.com/feed.xml", "已复制订阅地址");
    });

    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result.current.map((toast) => toast.message)).toContain("已复制订阅地址");
    // 临时 textarea 必须摘干净，不能留在 DOM 里
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("安全上下文（有 clipboard）优先用异步剪贴板，不碰 execCommand", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const execCommand = mockExecCommand(true);
    const { result } = renderHook(() => useToasts());

    let ok = false;
    await act(async () => {
      ok = await copyToClipboard("https://example.com/feed.xml", "已复制订阅地址");
    });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.com/feed.xml");
    expect(execCommand).not.toHaveBeenCalled();
    expect(result.current.map((toast) => toast.message)).toContain("已复制订阅地址");
  });

  it("writeText 被浏览器拒绝（权限/非聚焦）时不留静默失败", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    const { result } = renderHook(() => useToasts());

    let ok = true;
    await act(async () => {
      ok = await copyToClipboard("x", "已复制");
    });

    expect(ok).toBe(false);
    expect(result.current.map((toast) => toast.message)).toContain(
      "复制失败，请手动复制",
    );
  });

  it("两条路都断了才报失败，且文案走 i18n", async () => {
    mockExecCommand(false);
    const { result } = renderHook(() => useToasts());

    let ok = true;
    await act(async () => {
      ok = await copyToClipboard("x", "已复制");
    });

    expect(ok).toBe(false);
    const messages = result.current.map((toast) => toast.message);
    expect(messages).toContain("复制失败，请手动复制");
    expect(messages).not.toContain("已复制");
  });
});
