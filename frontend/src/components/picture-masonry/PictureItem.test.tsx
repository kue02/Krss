import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, Feed } from "@/types/api";

const dims = vi.hoisted(() => new Map<string, { ratio: number }>());
const setDimension = vi.hoisted(() =>
  vi.fn((src: string, width: number, height: number) => {
    dims.set(src, { ratio: width / height });
  }),
);
const markFailed = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/image-dimensions-store", () => ({
  useImageDimensionsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        setDimension,
        markFailed,
        loadFromDB: vi.fn(),
        dimensions: {},
        failedImages: new Set(),
      }),
    { getState: () => ({ setDimension, markFailed }) },
  ),
  useImageDimension: (src?: string) => (src ? dims.get(src) : undefined),
  useImageFailed: () => false,
}));

vi.mock("@/stores/lightbox-store", () => ({
  useLightboxStore: (selector: (state: unknown) => unknown) =>
    selector({ open: vi.fn() }),
}));

vi.mock("@/lib/image-proxy", () => ({
  getProxiedImageUrl: (url: string) => url,
}));

import { PictureItem } from "./PictureItem";

const entry = {
  id: "1",
  feedId: "10",
  title: "A picture",
  url: "https://example.com/post",
  content: "",
  thumbnailUrl: "https://example.com/a.jpg",
  read: false,
  starred: false,
  muted: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Entry;

const feed = { id: "10", title: "F", iconPath: undefined } as unknown as Feed;

/** 把「这张图已在缓存里」的假象装到所有 <img> 上 */
function pretendCached(width: number, height: number) {
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    get: () => true,
    configurable: true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    get: () => width,
    configurable: true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    get: () => height,
    configurable: true,
  });
}

function restoreImageProto() {
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)
    .complete;
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)
    .naturalWidth;
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)
    .naturalHeight;
}

describe("PictureItem 图片尺寸记录", () => {
  beforeEach(() => {
    setDimension.mockClear();
    dims.clear();
  });

  afterEach(() => {
    restoreImageProto();
  });

  /** 图片容器上写着 aspect-ratio —— 瀑布流「不规则」全靠它 */
  function containerRatio(container: HTMLElement): number {
    const el = container.querySelector("[style*='aspect-ratio']") as HTMLElement;
    return Number.parseFloat(el.style.aspectRatio);
  }

  it("未知尺寸时退回默认 3:4（0.75）", () => {
    const { container } = render(<PictureItem entry={entry} feed={feed} />);
    expect(containerRatio(container)).toBeCloseTo(0.75, 2);
    expect(setDimension).not.toHaveBeenCalled();
  });

  /**
   * 回归（用户 2026-09-17 反馈「格子一样高、不是不规则那种」）：
   * 命中缓存的图片不会再触发 onLoad，只靠 onLoad 记尺寸的话真实宽高永远是空的，
   * 于是所有格子都退回 0.75 → 看起来是规整网格。挂载时补记一次即可解决。
   */
  it("图片已缓存（complete=true）时，挂载就记录真实宽高，并按真实比例排版", () => {
    pretendCached(1200, 400);
    const { container } = render(<PictureItem entry={entry} feed={feed} />);

    expect(setDimension).toHaveBeenCalledWith(
      "https://example.com/a.jpg",
      1200,
      400,
    );
    // 记录之后容器要按真实比例（3:1）排版 —— 格子高度才会参差
    expect(containerRatio(container)).toBeCloseTo(3, 2);
  });

  it("网格模式强制 1:1（与真实比例无关）", () => {
    pretendCached(1200, 400);
    const { container } = render(
      <PictureItem entry={entry} feed={feed} square />,
    );
    expect(containerRatio(container)).toBe(1);
  });
});
