import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialMediaGallery } from "./SocialMediaGallery";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";

vi.mock("@/lib/proxy-image-recovery", () => ({
  isRecoverableProxyUrl: () => false,
  renewProxyCookie: () => Promise.resolve(),
  withProxyCacheBust: (url: string) => url,
}));

vi.mock("@/stores/image-dimensions-store", () => ({
  useImageDimensionsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        dimensions: {},
        failedImages: new Set<string>(),
        setDimension: vi.fn(),
        markFailed: vi.fn(),
        loadFromDB: vi.fn(),
      }),
    { getState: vi.fn() },
  ),
}));

beforeEach(() => {
  useImageDimensionsStore.getState?.();
});

describe("SocialMediaGallery", () => {
  const media = [
    { src: "https://example.com/a.jpg", width: 800, height: 600 },
    { src: "https://example.com/b.jpg", width: 800, height: 600 },
  ];

  it("点图片只开大图查看器，不冒泡到卡片（不选中/不进正文）", () => {
    const onOpenImage = vi.fn();
    const onCardClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onCardClick}>
        <SocialMediaGallery media={media} onOpenImage={onOpenImage} />
      </div>,
    );

    const buttons = screen.getAllByRole("button", { name: "查看大图" });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]!);

    // 灯箱意图：调 onOpenImage，参数是 URL 列表 + 被点下标
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    expect(onOpenImage.mock.calls[0]?.[1]).toBe(0);
    // 卡片自身的 onClick 不得触发（即不得 selectEntry / 不得推进正文）
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("点第二张图时下标对得上", () => {
    const onOpenImage = vi.fn();
    render(
      <div>
        <SocialMediaGallery media={media} onOpenImage={onOpenImage} />
      </div>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "查看大图" })[1]!);

    expect(onOpenImage).toHaveBeenCalledTimes(1);
    expect(onOpenImage.mock.calls[0]?.[1]).toBe(1);
  });
});
