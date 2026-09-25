import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArticleVideo } from "./article-video";

// video.play 在 jsdom 里是抛 NotImplemented 的桩，这里给可控实现
const playMock = vi.fn(() => Promise.resolve());
const pauseMock = vi.fn();

function mountVideo() {
  const { container } = render(
    <ArticleVideo src="https://example.com/v.mp4" />,
  );
  const video = container.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "play", { value: playMock, writable: true });
  Object.defineProperty(video, "pause", { value: pauseMock, writable: true });
  return { container, video };
}

describe("ArticleVideo 封面 + 悬停（§2.25）", () => {
  it("无 poster 时 preload=metadata（只拉头部、首帧当封面）", () => {
    const { video } = mountVideo();
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("poster")).toBe(false);
    // 就地静音 + 内联，不打扰用户
    expect(video.muted).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
  });

  it("有 poster 时 preload=none（进页面零请求）", () => {
    const { container } = render(
      <ArticleVideo
        src="https://example.com/v.mp4"
        poster="https://example.com/p.jpg"
      />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("preload")).toBe("none");
    // poster 按铁律走代理：断言“走了代理且目标是那张图”（base64 可解回原地址）
    const posterAttr = video.getAttribute("poster") ?? "";
    expect(posterAttr).toContain("/api/proxy/image/");
    const b64 = posterAttr.split("/").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString()).toBe(
      "https://example.com/p.jpg",
    );
  });

  it("悬停 → 调 play；移开 → pause（回封面）", () => {
    const { container } = mountVideo();
    const btn = screen.getByRole("button", { name: "播放视频" });

    fireEvent.mouseEnter(btn);
    expect(playMock).toHaveBeenCalledTimes(1);
    // 进度条出现
    expect(
      container.querySelector('[data-slot="article-video-progress"]'),
    ).not.toBeNull();

    fireEvent.mouseLeave(btn);
    expect(pauseMock).toHaveBeenCalled();
    // 回到封面：进度条收起
    expect(
      container.querySelector('[data-slot="article-video-progress"]'),
    ).toBeNull();
  });

  it("timeupdate 推进进度值（0~1）", () => {
    const { container, video } = mountVideo();
    const btn = screen.getByRole("button", { name: "播放视频" });
    fireEvent.mouseEnter(btn);

    Object.defineProperty(video, "duration", { value: 10, writable: true });
    Object.defineProperty(video, "currentTime", { value: 2.5, writable: true });
    fireEvent.timeUpdate(video);

    const bar = container.querySelector(
      '[data-slot="article-video-progress"]',
    );
    expect(bar?.getAttribute("aria-valuenow")).toBe("0.25");
  });

  it("无 poster 时 src 补 #t=0.1（逼浏览器 seek 出首帧当封面）", () => {
    const { video } = mountVideo();
    const src = video.getAttribute("src") ?? "";
    // 仍走代理，且尾部带片段
    expect(src).toContain("/api/proxy/image/");
    expect(src.endsWith("#t=0.1")).toBe(true);
  });

  it("有 poster 时不补 #t=0.1（封面用 poster，不必拉视频）", () => {
    const { container } = render(
      <ArticleVideo
        src="https://example.com/v.mp4"
        poster="https://example.com/p.jpg"
      />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src") ?? "").not.toContain("#t=0.1");
  });

  it("首帧未到压骨架、loadeddata 后撤骨架（不露白/黑空框）", () => {
    const { container, video } = mountVideo();
    const skeleton = () =>
      container.querySelector('[data-slot="article-video-skeleton"]');
    expect(skeleton()).not.toBeNull();
    expect(video.className).toContain("opacity-0");

    fireEvent.loadedData(video);
    expect(skeleton()).toBeNull();
    expect(video.className).toContain("opacity-100");
  });

  it("错误态：中性底、播不了也不纯黑空框", () => {
    const { container } = mountVideo();
    const video = container.querySelector("video") as HTMLVideoElement;
    fireEvent.error(video);
    const btn = screen.getByRole("button", { name: "播放视频" });
    expect(btn.className).toContain("bg-secondary");
    expect(btn.className).not.toContain("bg-black");
    // 兜底出口
    expect(screen.getByText("视频加载失败，在新窗口打开")).not.toBeNull();
  });
});
