import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseHtml } from "@/lib/parse-html";
import { ArticleIframe, resolveIframeSrc } from "./article-iframe";

afterEach(cleanup);

const uiState = vi.hoisted(() => ({
  unknownClickToLoad: true,
  hosts: [] as string[],
}));

vi.mock("@/hooks/useUISettings", () => ({
  useUISettingKey: (key: string) =>
    key === "iframeVideoHosts"
      ? uiState.hosts
      : key === "iframeUnknownClickToLoad"
        ? uiState.unknownClickToLoad
        : undefined,
}));

beforeEach(() => {
  uiState.unknownClickToLoad = true;
  uiState.hosts = [];
});

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  expect(iframe).not.toBeNull();
  return iframe as HTMLIFrameElement;
}

describe("ArticleIframe · 正文内嵌视频", () => {
  it("bilibili 按 bvid 改写成黑板 HTML5 播放器，并带上安全属性", () => {
    const { container } = render(
      <ArticleIframe src="https://player.bilibili.com/player.html?aid=1&bvid=BV1tZh76LEVK" />,
    );
    const iframe = getIframe(container);

    expect(iframe.getAttribute("src")).toBe(
      "https://www.bilibili.com/blackboard/html5mobileplayer.html?isOutside=true&bvid=BV1tZh76LEVK&p=1&hideCoverInfo=1&danmaku=0",
    );
    expect(iframe.getAttribute("loading")).toBe("lazy");
    expect(iframe.getAttribute("referrerpolicy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.hasAttribute("allowfullscreen")).toBe(true);
  });

  it("YouTube 脏数据 &quot; 被清掉并归一成 YouTube embed", () => {
    const { container } = render(
      <ArticleIframe src="https://www.youtube-nocookie.com/embed/&quot;zBIQAo1By8M?fs=1&modestbranding=1&rel=0" />,
    );
    expect(getIframe(container).getAttribute("src")).toBe(
      "https://www.youtube.com/embed/zBIQAo1By8M?rel=0&modestbranding=1&playsinline=1",
    );
  });

  it("YouTube watch 地址归一成 embed 并保留 start", () => {
    expect(
      resolveIframeSrc("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30"),
    ).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1&start=30",
    );
  });

  it("Wistia 原样保留", () => {
    const src = "https://fast.wistia.net/embed/iframe/xvo2is4xe2?web_component=true&seo=false";
    const { container } = render(<ArticleIframe src={src} />);
    expect(getIframe(container).getAttribute("src")).toBe(src);
  });

  it("非白名单域名默认显示点击加载占位，点击后才挂 iframe", () => {
    const { container } = render(
      <ArticleIframe src="https://video.example/embed/x" />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    const placeholder = container.querySelector(
      '[data-slot="article-iframe-placeholder"]',
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain("video.example");

    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://video.example/embed/x",
    );
  });

  it("用户白名单里的站点直接内嵌", () => {
    expect(
      resolveIframeSrc("https://video.example/embed/x", ["video.example"]),
    ).toBe("https://video.example/embed/x");
  });

  it("javascript: 地址既不内嵌也不给外链", () => {
    const { container } = render(<ArticleIframe src="javascript:alert(1)" />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("协议相对地址经 parseHtml → ArticleIframe 仍能渲染", () => {
    const result = parseHtml(
      '<iframe src="//player.bilibili.com/player.html?bvid=BV1tZh76LEVK"></iframe>',
      {
        components: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          iframe: ({ node: _, ...props }) =>
            createElement(ArticleIframe, props),
        },
      },
    );
    const { container } = render(result.toContent());
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://www.bilibili.com/blackboard/html5mobileplayer.html?isOutside=true&bvid=BV1tZh76LEVK&p=1&hideCoverInfo=1&danmaku=0",
    );
  });

  it("畸形百分号编码不抛异常，降级外链", () => {
    expect(() =>
      render(<ArticleIframe src="https://www.youtube.com/embed/100%pure" />),
    ).not.toThrow();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://www.youtube.com/embed/100%pure",
    );
  });

  it("YouTube playlist 无法内嵌时降级外链，不塞原始页", () => {
    const { container } = render(
      <ArticleIframe src="https://www.youtube.com/playlist?list=PL123" />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toContain(
      "youtube.com/playlist",
    );
  });

  it("不使用源内容的 allow，固定用内置权限集合", () => {
    const { container } = render(
      <ArticleIframe
        src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        allow="camera; microphone"
      />,
    );
    const allow = getIframe(container).getAttribute("allow") ?? "";
    expect(allow).not.toContain("camera");
    expect(allow).toContain("fullscreen");
  });

  it("1×1 / display:none 的追踪 iframe 不生成可见外链药丸", () => {
    const tiny = render(
      <ArticleIframe src="https://evil.example/pixel" width={1} height={1} />,
    );
    expect(tiny.container.querySelector("a")).toBeNull();
    cleanup();
    const hidden = render(
      <ArticleIframe
        src="https://evil.example/pixel"
        style={{ display: "none" }}
      />,
    );
    expect(hidden.container.querySelector("a")).toBeNull();
  });
  it("关闭「未知站点点击加载」后，未知视频 iframe 降级为外链药丸", () => {
    uiState.unknownClickToLoad = false;
    const { container } = render(
      <ArticleIframe src="https://video.example/embed/x" />,
    );
    expect(
      container.querySelector('[data-slot="article-iframe-placeholder"]'),
    ).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://video.example/embed/x",
    );
  });

  it("未知非视频 iframe 保持外链药丸，不生成视频占位", () => {
    for (const src of [
      "https://widgets.example/map/widget",
      "https://platform.twitter.com/embed/Tweet.html?id=1",
      "https://www.google.com/maps/embed?pb=abc",
    ]) {
      const { container, unmount } = render(<ArticleIframe src={src} />);
      expect(
        container.querySelector('[data-slot="article-iframe-placeholder"]'),
      ).toBeNull();
      expect(screen.getByRole("link").getAttribute("href")).toBe(src);
      unmount();
    }
  });

  it("用户白名单中的未知视频站点直接内嵌（不经点击占位）", () => {
    uiState.hosts = ["video.example"];
    const { container } = render(
      <ArticleIframe src="https://video.example/embed/x" />,
    );
    expect(
      container.querySelector('[data-slot="article-iframe-placeholder"]'),
    ).toBeNull();
    expect(getIframe(container).getAttribute("src")).toBe(
      "https://video.example/embed/x",
    );
  });

});
