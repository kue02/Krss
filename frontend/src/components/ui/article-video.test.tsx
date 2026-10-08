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
  /** 42-7：控制条要先有 duration（metadata 到齐）才渲染 Slider */
  function primeDuration(video: HTMLVideoElement, duration = 30) {
    Object.defineProperty(video, "duration", { value: duration, writable: true });
    fireEvent.loadedMetadata(video);
  }

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
    const { container, video } = mountVideo();
    primeDuration(video);
    const btn = screen.getByRole("button", { name: "播放视频" });

    fireEvent.mouseEnter(btn);
    expect(playMock).toHaveBeenCalledTimes(1);
    // 控制条出现
    expect(
      container.querySelector('[data-slot="article-video-controls"]'),
    ).not.toBeNull();

    fireEvent.mouseLeave(btn);
    expect(pauseMock).toHaveBeenCalled();
    // 回到封面：控制条收起
    expect(
      container.querySelector('[data-slot="article-video-controls"]'),
    ).toBeNull();
  });

  it("timeupdate 推进播放头（Slider 的值 = currentTime，maxValue = duration）", () => {
    const { container, video } = mountVideo();
    const btn = screen.getByRole("button", { name: "播放视频" });
    fireEvent.mouseEnter(btn);
    primeDuration(video, 10);

    Object.defineProperty(video, "currentTime", { value: 2.5, writable: true });
    fireEvent.timeUpdate(video);

    const bar = container.querySelector(
      '[data-slot="article-video-progress"] input[type="range"]',
    );
    expect(bar?.getAttribute("max")).toBe("10");
    expect(bar?.getAttribute("value")).toBe("2.5");
  });

  it("duration 未到齐时不渲染 Slider（没有刻度可跳）", () => {
    const { container } = mountVideo();
    const btn = screen.getByRole("button", { name: "播放视频" });
    fireEvent.mouseEnter(btn);
    expect(
      container.querySelector('[data-slot="article-video-controls"]'),
    ).toBeNull();
  });

  it("拖拽进度条 → 直接 seek（currentTime 跟着改）", () => {
    const { container, video } = mountVideo();
    const btn = screen.getByRole("button", { name: "播放视频" });
    fireEvent.mouseEnter(btn);
    primeDuration(video, 30);

    const range = container.querySelector(
      '[data-slot="article-video-progress"] input[type="range"]',
    ) as HTMLInputElement;
    expect(range).not.toBeNull();

    fireEvent.change(range, { target: { value: "21" } });
    expect(video.currentTime).toBe(21);
  });

  it("控制条上的播放/暂停钮切 play/pause（不是打开大屏）", async () => {
    const { container } = mountVideo();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "播放视频" }));
    const video = container.querySelector("video") as HTMLVideoElement;
    primeDuration(video);

    // 测试环境没初始化 i18n，t() 回显 key —— 按 key 断言（组件里走的就是 t(...)）
    // 悬停触发 play()，按钮要等 promise resolve 后才从「播放」翻成「暂停」
    const pauseBtn = await screen.findByRole("button", {
      name: "entry.video_pause",
    });

    pauseMock.mockClear();
    fireEvent.click(pauseBtn);
    expect(pauseMock).toHaveBeenCalled();
    // 暂停后按钮翻回「播放」，控制条仍在（没被换成大屏播放器）
    const playBtn = await screen.findByRole("button", {
      name: "entry.video_play",
    });
    expect(playBtn).not.toBeNull();

    playMock.mockClear();
    fireEvent.click(playBtn);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-slot="article-video-controls"]'),
    ).not.toBeNull();
  });

  it("控制条里的按钮不是嵌套 button（外层是 div[role=button]）", () => {
    const { container, video } = mountVideo();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "播放视频" }));
    primeDuration(video);

    const card = container.querySelector(".article-video") as HTMLElement;
    expect(card.tagName).toBe("DIV");
    expect(card.getAttribute("role")).toBe("button");
    // 容器里不能有 button  descendant（非法嵌套）
    expect(card.querySelector("button button")).toBeNull();
    // 键盘可达
    expect(card.getAttribute("tabindex")).toBe("0");
  });

  it("控制条按钮不吃卡片点击（不会误开大屏）", () => {
    const { container, video } = mountVideo();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "播放视频" }));
    primeDuration(video);

    // 事件冒泡到容器时会被 closest(controls) 拦下 → 控制条仍在（没被换成大屏播放器）
    fireEvent.click(screen.getByRole("button", { name: "entry.video_play" }));
    expect(
      container.querySelector('[data-slot="article-video-controls"]'),
    ).not.toBeNull();
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
