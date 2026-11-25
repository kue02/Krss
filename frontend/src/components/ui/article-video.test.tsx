import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ArticleVideo } from "./article-video";

// 真实 @videojs/react 在 jsdom 里首次 import + 挂载约 2~8s（冷启动 / 整包并发时更慢），
// 这里给足超时；跑的是真的 Video.js 皮肤，不是桩。
const VIDEO_TEST_TIMEOUT = 30000;

afterEach(cleanup);

/** Video.js 播放器是懒加载的（React.lazy）：等真正的 `<video>` 挂上来再断言。 */
async function waitForVideo(container: HTMLElement): Promise<HTMLVideoElement> {
  await waitFor(
    () => {
      expect(container.querySelector("video")).not.toBeNull();
    },
    { timeout: 20000 },
  );
  return container.querySelector("video") as HTMLVideoElement;
}

function decodeProxyTarget(url: string): string {
  // /api/proxy/image/<base64url>?ref=... —— 取最后一段（去掉查询串）解回原地址
  const [path = ""] = url.split("?");
  const b64 = path.split("/").pop() ?? "";
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString();
}

describe("ArticleVideo · Video.js 播放器（NextFlux 同款）", () => {
  it(
    "src 走代理，渲染出 Video.js 皮肤与控制条",
    async () => {
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);

      const src = video.getAttribute("src") ?? "";
      expect(src).toContain("/api/proxy/image/");
      expect(decodeProxyTarget(src)).toBe("https://example.com/v.mp4");

      // Video.js 皮肤容器（media-container / data-preset=video）
      const skin = container.querySelector(".media-container");
      expect(skin).not.toBeNull();
      expect(skin?.getAttribute("data-preset")).toBe("video");
      // 播放器自带控制条（播放按钮）
      expect(container.querySelector(".media-play-button")).not.toBeNull();
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "有 poster 时 poster 也走代理并交给 video",
    async () => {
      const { container } = render(
        <ArticleVideo
          src="https://example.com/v.mp4"
          poster="https://example.com/p.jpg"
        />,
      );
      const video = await waitForVideo(container);
      const posterAttr = video.getAttribute("poster") ?? "";
      expect(posterAttr).toContain("/api/proxy/image/");
      expect(decodeProxyTarget(posterAttr)).toBe("https://example.com/p.jpg");
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "无 poster 时 preload=metadata（只拉头部）、内联播放",
    async () => {
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      expect(video.getAttribute("preload")).toBe("metadata");
      expect(video.hasAttribute("poster")).toBe(false);
      expect(video.hasAttribute("playsinline")).toBe(true);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "播放器下方挂来源药丸：hostname + 外链原视频",
    async () => {
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      await waitForVideo(container);

      const link = screen.getByRole("link", { name: /example\.com/ });
      expect(link.getAttribute("href")).toBe("https://example.com/v.mp4");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "source-only（地址写在 <source src>）：首个 source 变主地址并走代理",
    async () => {
      const { container } = render(
        <ArticleVideo>
          <source src="https://example.com/s.mp4" type="video/mp4" />
        </ArticleVideo>,
      );
      const video = await waitForVideo(container);
      const src = video.getAttribute("src") ?? "";
      expect(src).toContain("/api/proxy/image/");
      expect(decodeProxyTarget(src)).toBe("https://example.com/s.mp4");
      // 主 video 已用 src，不再重复渲染 <source> 子节点
      expect(video.querySelector("source")).toBeNull();
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "非 http 地址（如 blob:）不给来源药丸",
    async () => {
      const { container } = render(<ArticleVideo src="blob:whatever" />);
      await waitForVideo(container);
      expect(screen.queryByRole("link", { name: /example\.com/ })).toBeNull();
    },
    VIDEO_TEST_TIMEOUT,
  );
});
