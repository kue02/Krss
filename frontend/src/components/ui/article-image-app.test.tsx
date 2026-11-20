import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/lib/image-dimensions-db", () => ({
  getDimensionsBatch: vi.fn(),
  saveDimension: vi.fn(),
}));

/**
 * 复审 P2：App 里没有 cookie，图片失败时不能走 `renewProxyCookie` 那条续期路
 * （续完还是 401），应该丢掉旧 blob、用当前 token 重新取一次。
 */
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ArticleImage · App 内 token 重取（复审 P2）", () => {
  it("blob 加载失败时用当前 token 重取一次，不走 cookie 续期", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090");
    vi.resetModules();
    localStorage.setItem("krss_auth_token", "tok-app");

    let n = 0;
    const revoke = vi.fn();
    const fetchSpy = vi.fn().mockImplementation(async () => ({
      ok: true,
      blob: async () => new Blob(["img"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:retry-${++n}`),
        revokeObjectURL: revoke,
      }),
    );

    const { ArticleImage } = await import("./article-image");
    const { container } = render(
      <ArticleImage src="https://example.com/a.jpg" alt="x" />,
    );
    const img = container.querySelector("img") as HTMLImageElement;

    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:retry-1"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.error(img);

    await waitFor(() => expect(img.getAttribute("src")).toBe("blob:retry-2"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/proxy/image/"),
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-app" },
      }),
    );
    // 旧 blob 被回收，不是越积越多
    expect(revoke).toHaveBeenCalledWith("blob:retry-1");
  });
});
