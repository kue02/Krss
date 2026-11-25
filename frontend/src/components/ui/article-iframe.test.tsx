import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
