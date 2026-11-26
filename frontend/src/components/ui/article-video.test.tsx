import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ArticleVideo } from "./article-video";

// 真实 @videojs/react 在 jsdom 里首次 import + 挂载约 2~8s（冷启动 / 整包并发时更慢），
// 这里给足超时；跑的是真的 Video.js 皮肤，不是桩。
const VIDEO_TEST_TIMEOUT = 30000;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * 假 IntersectionObserver：jsdom 没有实现，预载测试需要一个能手动触发「进入视口」的替身。
 * 返回的 trigger() 把所有已观察元素当作 isIntersecting 回调一次。
 */
function stubIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const observed: Element[] = [];

  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }
    observe(target: Element) {
      observed.push(target);
    }
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

  return {
    trigger() {
      const entries = observed.map(
        (target) =>
          ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry,
      );
      for (const callback of callbacks) {
        callback(entries, {} as IntersectionObserver);
      }
    },
  };
}

/** 拿到悬停预览的那层容器（`article-video-player.tsx` 里挂指针事件的 div）。 */
function getSurface(container: HTMLElement): Element {
  const surface = container.querySelector('[data-slot="article-video-player"]');
  expect(surface).not.toBeNull();
  return surface as Element;
}

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
    "无 poster 时 preload 先 metadata、进入视口后升 auto、内联播放",
    async () => {
      // jsdom 没有 IntersectionObserver 时 useInView 首帧就是 true（降级语义），
      // 所以这里装一个假的 IO，才能断言「没进视口 = metadata，进了 = auto」。
      // 原断言（固定 metadata）是「还没做视口预载」时代的，语义已变。
      const io = stubIntersectionObserver();
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      expect(video.getAttribute("preload")).toBe("metadata");
      expect(video.hasAttribute("poster")).toBe(false);
      expect(video.hasAttribute("playsinline")).toBe(true);

      await act(async () => {
        io.trigger();
      });
      await waitFor(() => {
        expect(video.getAttribute("preload")).toBe("auto");
      });
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "没有 IntersectionObserver 的环境直接按 auto 预载（降级不倒退）",
    async () => {
      // jsdom 默认就没有 IO：useInView 首帧 inView=true，视频按 auto 预载，
      // 不会因为观察不到视口就永远停在 metadata。
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      expect(video.getAttribute("preload")).toBe("auto");
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

  it(
    "悬停静音就地播放、移开暂停并回到封面",
    async () => {
      // jsdom 的 play()/pause() 是 notImplementedMethod（返回 undefined 且刷 console.error），
      // 悬停预览要真被观察到就必须换掉。
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      const pause = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo
          src="https://example.com/v.mp4"
          poster="https://example.com/p.jpg"
        />,
      );
      const video = await waitForVideo(container);
      expect(video.muted).toBe(false);

      fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });

      expect(play).toHaveBeenCalled();
      // 先静音再 play：不静音的自动播放会被浏览器策略拒掉
      expect(video.muted).toBe(true);

      // 假装真的播了一点，验证移开会归零回封面
      video.currentTime = 3;

      fireEvent.pointerLeave(getSurface(container), { pointerType: "mouse" });

      expect(pause).toHaveBeenCalled();
      expect(video.currentTime).toBe(0);
      // 恢复用户原本的静音状态（原本有声 → 移开后仍是有声，但不自动播）
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "play() 被浏览器策略拒绝时静默降级，不留 unhandled rejection",
    async () => {
      // 自动播放策略拒播时 play() 返回 rejected Promise：
      // 既不能冒泡成 unhandledrejection，也不能卡住界面。
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);

      try {
        const { container } = render(
          <ArticleVideo src="https://example.com/v.mp4" />,
        );
        const video = await waitForVideo(container);

        fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });
        expect(play).toHaveBeenCalled();
        // 拒绝后仍保持静音（补播时还是静音的），也不抛错
        await waitFor(() => {
          expect(video.muted).toBe(true);
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "预览期间用户点了播放：移开不再暂停、不回封面",
    async () => {
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      const pause = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      const surface = getSurface(container);

      fireEvent.pointerEnter(surface, { pointerType: "mouse" });
      expect(play).toHaveBeenCalled();
      video.currentTime = 4;

      // 用户按下播放键 / 键盘操作 = 接管控制权
      fireEvent.pointerDown(surface);
      pause.mockClear();

      fireEvent.pointerLeave(surface, { pointerType: "mouse" });

      // 不打断用户的播放，也不把进度清零
      expect(pause).not.toHaveBeenCalled();
      expect(video.currentTime).toBe(4);
      // 静音是我们改的，仍然要还回去
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "prefers-reduced-motion: reduce 时不做悬停预览",
    async () => {
      // jsdom 没有 matchMedia，这里补一个只认 reduce 的替身。
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }));
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);

      fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });

      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "用户已经看过一段（currentTime > 0）时悬停不插手",
    async () => {
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      video.currentTime = 5;

      fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });

      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(false);
      expect(video.currentTime).toBe(5);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "触摸指针不触发悬停预览",
    async () => {
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);

      fireEvent.pointerEnter(getSurface(container), { pointerType: "touch" });

      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );
});
