import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("useAuthedImageUrl", () => {
  it("同源构建直接返回原 src，不发额外请求", async () => {
    vi.stubEnv("VITE_API_URL", "");
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { useAuthedImageUrl } = await import("./use-authed-image");
    const { result } = renderHook(() => useAuthedImageUrl("/api/proxy/image/abc"));
    expect(result.current).toBe("/api/proxy/image/abc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("App 模式带 Bearer token 取图并返回 blob URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090");
    vi.resetModules();
    localStorage.setItem("krss_auth_token", "tok-123");
    const blob = new Blob(["img"], { type: "image/png" });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:mock-1"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const { useAuthedImageUrl } = await import("./use-authed-image");
    const { result } = renderHook(() =>
      useAuthedImageUrl("http://192.168.1.5:8090/api/proxy/image/abc"),
    );
    await waitFor(() => expect(result.current).toBe("blob:mock-1"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://192.168.1.5:8090/api/proxy/image/abc",
      expect.objectContaining({ headers: { Authorization: "Bearer tok-123" } }),
    );
    localStorage.removeItem("krss_auth_token");
  });


  it("批量图集：App 模式逐张取回 blob URL，保持顺序", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090");
    vi.resetModules();
    localStorage.setItem("krss_auth_token", "tok-123");
    let n = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => ({
      ok: true,
      blob: async () => new Blob(["img"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:mock-${++n}`),
        revokeObjectURL: vi.fn(),
      }),
    );
    const { useAuthedImageUrls } = await import("./use-authed-image");
    const { result } = renderHook(() =>
      useAuthedImageUrls([
        "http://192.168.1.5:8090/api/proxy/image/a",
        "http://192.168.1.5:8090/api/proxy/image/b",
      ]),
    );
    await waitFor(() =>
      expect(result.current).toEqual(["blob:mock-1", "blob:mock-2"]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    localStorage.removeItem("krss_auth_token");
  });
});
