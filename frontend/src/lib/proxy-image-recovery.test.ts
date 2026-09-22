import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isRecoverableProxyUrl,
  withProxyCacheBust,
  initProxyImageRecovery,
  resetProxyImageRecovery,
} from "./proxy-image-recovery";

vi.mock("@/api", () => ({
  getCurrentUser: vi.fn(() => Promise.resolve({ username: "kue" })),
}));

import { getCurrentUser } from "@/api";

describe("proxy-image-recovery（24-4）", () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockClear();
  });

  afterEach(() => {
    resetProxyImageRecovery();
    document.body.innerHTML = "";
  });

  it("只有 /api/proxy/ 的图才值得救", () => {
    expect(isRecoverableProxyUrl("/api/proxy/image/abc")).toBe(true);
    expect(
      isRecoverableProxyUrl("http://x:5176/api/proxy/image/abc?ref=zzz"),
    ).toBe(true);
    expect(isRecoverableProxyUrl("/icons/feed.png")).toBe(false);
    expect(isRecoverableProxyUrl("https://example.com/a.jpg")).toBe(false);
  });

  it("cache-bust 只追加 _r=1，后端忽略该参数", () => {
    expect(withProxyCacheBust("/api/proxy/image/abc")).toBe(
      "/api/proxy/image/abc?_r=1",
    );
    expect(withProxyCacheBust("/api/proxy/image/abc?ref=zzz")).toBe(
      "/api/proxy/image/abc?ref=zzz&_r=1",
    );
    // 幂等：救过一次的不再叠
    expect(
      withProxyCacheBust("/api/proxy/image/abc?_r=1"),
    ).toBe("/api/proxy/image/abc?_r=1");
  });

  it("裸 img 挂了先续期 cookie 再重载，每张只救一次", async () => {
    initProxyImageRecovery();
    const img = document.createElement("img");
    img.src = "/api/proxy/image/abc";
    document.body.appendChild(img);

    img.dispatchEvent(new Event("error"));
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(vi.mocked(getCurrentUser)).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(img.src).toContain("_r=1");
    });

    // 第二次挂（续期也救不回来）：不再调续期，不循环
    img.dispatchEvent(new Event("error"));
    await Promise.resolve();
    expect(vi.mocked(getCurrentUser)).toHaveBeenCalledTimes(1);
    expect(img.src.match(/_r=1/g)).toHaveLength(1);
  });

  it("非代理图不管", async () => {
    initProxyImageRecovery();
    const img = document.createElement("img");
    img.src = "/icons/feed.png";
    document.body.appendChild(img);

    img.dispatchEvent(new Event("error"));
    await Promise.resolve();
    expect(vi.mocked(getCurrentUser)).not.toHaveBeenCalled();
  });
});
