import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * App（自定义 scheme）里 `<video src>` 带不上 Authorization 头：
 * `<source src>` 这种没有 video[src] 的写法，要把首个 source 换成带 token 的 blob URL。
 * 这里锁住新播放器（Video.js）沿用这条鉴权路径。
 */
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ArticleVideo · source-only（App 鉴权）", () => {
  it(
    "用首个 source 取鉴权 blob 作为 video src，且不再渲染 source 子节点",
    async () => {
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

      await waitFor(
        () => {
          expect(container.querySelector("video")?.getAttribute("src")).toBe(
            "blob:source-only",
          );
        },
        { timeout: 20000 },
      );
      const video = container.querySelector("video") as HTMLVideoElement;

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/proxy/"),
        expect.objectContaining({
          headers: { Authorization: "Bearer tok-app" },
        }),
      );
      // App 内不再渲染带 http 地址的 source 子节点
      expect(video.querySelector("source")).toBeNull();
    },
    30000,
  );
});
