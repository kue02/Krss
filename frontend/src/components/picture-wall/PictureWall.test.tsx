import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { WALL_MAX_TILES } from "@/lib/picture-wall";
import { PictureWall } from "./PictureWall";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/* jsdom 里起不了 WebGL（也不该在单测里跑 three）——把画廊原件换成记录入参的替身 */
vi.mock("@/components/block/art-gallery", () => ({
  default: ({ images, hint }: { images: string[]; hint?: string }) => (
    <div
      data-testid="art-gallery"
      data-count={images.length}
      data-hint={hint}
      data-first={images[0]}
    />
  ),
}));

function entry(id: string, content: string, thumbnailUrl?: string): Entry {
  return {
    id,
    title: id,
    content,
    thumbnailUrl,
    url: `https://example.com/${id}`,
  } as unknown as Entry;
}

const img = (src: string) => `<p>正文</p><img src="${src}" />`;

afterEach(() => {
  cleanup();
});

describe("图片视图 · 照片墙（31-1）", () => {
  it("把条目的照片铺成一面墙：去重、不按条目分组、带上拖拽提示", async () => {
    render(
      <PictureWall
        items={[
          { entry: entry("a", img("https://cdn.test/1.jpg")) },
          {
            entry: entry(
              "b",
              `${img("https://cdn.test/2.jpg")}${img("https://cdn.test/3.jpg")}`,
            ),
          },
          // 和第一条同一张图（不同条目的 ref 不同）⇒ 只应出现一次
          { entry: entry("c", img("https://cdn.test/1.jpg")) },
        ]}
      />,
    );
    const gallery = await screen.findByTestId("art-gallery");
    expect(gallery.getAttribute("data-count")).toBe("3");
    expect(gallery.getAttribute("data-hint")).toBe(
      "appearance_view.picture_wall_hint",
    );
  });

  it("照片数封顶在 WALL_MAX_TILES（图集张数平方增长，超了显存顶不住）", async () => {
    const entries = Array.from({ length: WALL_MAX_TILES + 40 }, (_, i) =>
      entry(`e${i}`, img(`https://cdn.test/${i}.jpg`)),
    );
    render(
      <PictureWall items={entries.map((e) => ({ entry: e }))} />,
    );
    const gallery = await screen.findByTestId("art-gallery");
    expect(gallery.getAttribute("data-count")).toBe(String(WALL_MAX_TILES));
    // 第一张 = 第一条目的第一张图（按本仓的代理地址形式）
    expect(gallery.getAttribute("data-first")).toBe(
      getProxiedImageUrl("https://cdn.test/0.jpg", "https://example.com/e0"),
    );
  });

  it("没有照片时不挂画廊，给一句可见的空态（不静默失败）", () => {
    render(
      <PictureWall
        items={[{ entry: entry("a", "<p>纯文字，没有图</p>") }]}
      />,
    );
    expect(screen.queryByTestId("art-gallery")).toBeNull();
    expect(screen.getByText("appearance_view.picture_wall_empty")).toBeTruthy();
  });
});
