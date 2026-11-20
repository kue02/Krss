import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * 复审 P2：`<video><source src=...></video>` 这种写法没有 video[src]，
 * 之前 App 内既不响应点击、也拿不到带鉴权的流。这里锁住修复：
 * 首个 source 变成主地址、App 内改成 blob src、source 子节点不再渲染。
 */
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ArticleVideo · source-only（App）", () => {
  it("用首个 source 取鉴权 blob 作为 video src，并显式 seek 首帧", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090");
    vi.resetModules();
    localStorage.setItem("krss_auth_token", "tok-app");

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["video"], { type: "video/mp4" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:source-only"),
        revokeObjectURL: vi.fn(),
      }),
    );

    const { ArticleVideo } = await import("./article-video");
    const { container } = render(
      <ArticleVideo>
        <source src="https://example.com/v.mp4" type="video/mp4" />
      </ArticleVideo>,
    );
    const video = container.querySelector("video") as HTMLVideoElement;

    await waitFor(() =>
      expect(video.getAttribute("src")).toBe("blob:source-only"),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/proxy/"),
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-app" },
      }),
    );
    // App 内不再渲染带 http 地址的 source 子节点
    expect(video.querySelector("source")).toBeNull();

    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBeCloseTo(0.1);
  });
});
