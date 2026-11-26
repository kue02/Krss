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

/** 悬停延迟是 120ms：测试里等过这个窗口，稳定拿到「已确认停留」之后的状态。 */
const HOVER_DELAY_WAIT = 220;
async function waitHoverStart() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HOVER_DELAY_WAIT));
  });
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
    "无 poster 时 preload 分级：离屏 none → 进视口 metadata → 悬停才 auto",
    async () => {
      // jsdom 没有 IntersectionObserver 时 useInViewNow 首帧就是 true（降级语义），
      // 所以这里装一个假的 IO，才能断言「离屏 none / 进视口 metadata / 悬停 auto」。
      const io = stubIntersectionObserver();
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      // 还没进视口：完全不在 auto，也不该占用带宽
      expect(video.getAttribute("preload")).toBe("none");
      expect(video.hasAttribute("poster")).toBe(false);
      expect(video.hasAttribute("playsinline")).toBe(true);

      // 进步进视口：只升到 metadata（拉几 KB 头，不整包下载）
      await act(async () => {
        io.trigger();
      });
      await waitFor(() => {
        expect(video.getAttribute("preload")).toBe("metadata");
      });

      // 悬停且停留满 120ms 才升 auto（扫过不升级）
      fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });
      await waitHoverStart();
      expect(play).toHaveBeenCalled();
      await waitFor(() => {
        expect(video.getAttribute("preload")).toBe("auto");
      });
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "没有 IntersectionObserver 的环境按 metadata 预载（可见即预载、但不自动整包下载）",
    async () => {
      // jsdom 默认没有 IO：useInViewNow 首帧 inView=true，但预载上限仍是 metadata，
      // 不会因为观察不到视口就一点不拉，也不会退化成滚过就 auto。
      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      expect(video.getAttribute("preload")).toBe("metadata");
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
      await waitHoverStart();

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
      // 回封面：皮肤 Poster 重新可见（data-visible 是 Video.js 皮肤的公开状态属性）
      expect(
        container.querySelector(".media-poster")?.hasAttribute("data-visible"),
      ).toBe(true);
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
        await waitHoverStart();
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
    "预览中点画面（视频被暂停）后移开：仍然回封面",
    async () => {
      // 旧版把「任意 pointerdown」当接管，导致点一下画面后移开就永远停在中途帧、
      // 封面再也回不来。现在接管只在 video 真的收到 pause/seeking/seeked 时判定，
      // 且「暂停」这种接管仍然安全回封面。
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
      const surface = getSurface(container);

      fireEvent.pointerEnter(surface, { pointerType: "mouse" });
      await waitHoverStart();
      expect(play).toHaveBeenCalled();
      video.currentTime = 4;

      // 用户点了画面 → 浏览器真的暂停了 video，触发原生 pause 事件
      video.dispatchEvent(new Event("pause"));
      pause.mockClear();

      fireEvent.pointerLeave(surface, { pointerType: "mouse" });

      // 归零 +暂停 + 封面回来
      expect(pause).toHaveBeenCalled();
      expect(video.currentTime).toBe(0);
      expect(video.muted).toBe(false);
      expect(
        container.querySelector(".media-poster")?.hasAttribute("data-visible"),
      ).toBe(true);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "接管后仍在有声播放时移开：保留播放、不动进度",
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
      await waitHoverStart();
      expect(play).toHaveBeenCalled();

      // 模拟「用户接管后正在有声播放」：jsdom 的 paused 恒为 true，这里把它覆写成
      // false；再派发 seeking 让预览会话判定为用户接管；最后取消静音。
      Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => false,
      });
      video.dispatchEvent(new Event("seeking"));
      video.muted = false;
      video.currentTime = 6;
      pause.mockClear();

      fireEvent.pointerLeave(surface, { pointerType: "mouse" });

      // 这是唯一保留播放的分支：不暂停、不归零
      expect(pause).not.toHaveBeenCalled();
      expect(video.currentTime).toBe(6);
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "悬停预览中用户点播放（仍静音）后移开：不暂停、且自动开声音",
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
      await waitHoverStart();
      expect(play).toHaveBeenCalled();
      expect(video.muted).toBe(true);

      // 用户点播放：此刻 video 还是静音（预览时设的），这正是「点播放后移开又被暂停」场景。
      // jsdom 的 paused 恒为 true，覆写成 false 模拟真的在播，再点真实的播放键。
      Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => false,
      });
      const playBtn = container.querySelector(".media-play-button");
      expect(playBtn).not.toBeNull();
      fireEvent.click(playBtn as Element);
      expect(video.muted).toBe(false);

      pause.mockClear();
      fireEvent.pointerLeave(surface, { pointerType: "mouse" });

      // 用户已经接管播放 → 移开不再暂停、不回封面
      expect(pause).not.toHaveBeenCalled();
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
      await waitHoverStart();

      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "看过一段（暂停在 currentTime > 0）后再悬停：仍能预览，移开还原到原位置",
    async () => {
      // 旧版守卫 `currentTime > 0` 会让人「看过一次就永远不能预览」。
      // 现在只有「正在播放」才不插手，暂停在中途也允许预览；
      // 起始位置不在封面，所以移开时还原到那一刻而不是归零。
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
      video.currentTime = 5;

      fireEvent.pointerEnter(getSurface(container), { pointerType: "mouse" });
      await waitHoverStart();

      expect(play).toHaveBeenCalled();
      expect(video.muted).toBe(true);

      fireEvent.pointerLeave(getSurface(container), { pointerType: "mouse" });

      expect(pause).toHaveBeenCalled();
      // 还原到预览前的位置（不是归零）
      expect(video.currentTime).toBe(5);
      expect(video.muted).toBe(false);
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
      await waitHoverStart();

      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "悬停不足 120ms 就移开：不拉流、不播放（防扫过偷跑流量）",
    async () => {
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      const surface = getSurface(container);

      fireEvent.pointerEnter(surface, { pointerType: "mouse" });
      // 立刻移开（远小于 HOVER_DELAY_MS = 120ms）
      fireEvent.pointerLeave(surface, { pointerType: "mouse" });

      // 等过延迟窗口，确认 timer 被清掉：没有 play，也没升 auto
      await waitHoverStart();
      expect(play).not.toHaveBeenCalled();
      expect(video.getAttribute("preload")).toBe("metadata");
      expect(video.muted).toBe(false);
    },
    VIDEO_TEST_TIMEOUT,
  );

  it(
    "悬停停留满 120ms 才升级 auto 并起播",
    async () => {
      const play = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

      const { container } = render(
        <ArticleVideo src="https://example.com/v.mp4" />,
      );
      const video = await waitForVideo(container);
      const surface = getSurface(container);

      fireEvent.pointerEnter(surface, { pointerType: "mouse" });
      // 还没到延迟：没开始
      expect(play).not.toHaveBeenCalled();
      expect(video.getAttribute("preload")).toBe("metadata");

      await waitHoverStart();
      expect(play).toHaveBeenCalled();
      expect(video.muted).toBe(true);
      expect(video.getAttribute("preload")).toBe("auto");
    },
    VIDEO_TEST_TIMEOUT,
  );
});
