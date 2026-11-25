import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { parseHtml } from "@/lib/parse-html";
import { ArticleIframe, resolveIframeSrc } from "./article-iframe";

afterEach(cleanup);

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

  it("YouTube 脏数据 &quot; 被清掉并归一成 youtube-nocookie embed", () => {
    const { container } = render(
      <ArticleIframe src="https://www.youtube-nocookie.com/embed/&quot;zBIQAo1By8M?fs=1&modestbranding=1&rel=0" />,
    );
    expect(getIframe(container).getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/zBIQAo1By8M?rel=0&modestbranding=1",
    );
  });

  it("YouTube watch 地址归一成 embed 并保留 start", () => {
    expect(
      resolveIframeSrc("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30"),
    ).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&start=30",
    );
  });

  it("Wistia 原样保留", () => {
    const src = "https://fast.wistia.net/embed/iframe/xvo2is4xe2?web_component=true&seo=false";
    const { container } = render(<ArticleIframe src={src} />);
    expect(getIframe(container).getAttribute("src")).toBe(src);
  });

  it("非白名单域名不内嵌，降级成外链药丸", () => {
    const { container } = render(
      <ArticleIframe src="https://evil.example/embed/x" />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://evil.example/embed/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("evil.example");
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
});
