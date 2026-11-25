import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useImagePreviewStore } from "@/stores/image-preview-store";
import { ImagePreview } from "./image-preview";

// Mock window.scrollTo (not implemented in jsdom)
vi.stubGlobal("scrollTo", vi.fn());

/**
 * jsdom 不一定实现 PointerEvent，用 MouseEvent 补 pointerType 等字段派发；
 * React 的 pointer 事件插件只读这些字段，足以驱动「触屏双击 pointerup 判定」。
 */
function fireTouchPointer(
  element: Element,
  type: "pointerdown" | "pointerup",
  x: number,
  y: number,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
  });
  fireEvent(element, event);
}

// Mock embla-carousel-react with controllable API
const mockScrollPrev = vi.fn();
const mockScrollNext = vi.fn();
const mockScrollTo = vi.fn();
const mockSelectedScrollSnap = vi.fn(() => 0);
const mockOn = vi.fn();
const mockOff = vi.fn();

// Store the embla options passed to useEmblaCarousel
let capturedEmblaOptions: {
  startIndex?: number;
  watchDrag?: (
    api?: unknown,
    event?: { touches?: { length: number } },
  ) => boolean;
} = {};

vi.mock("embla-carousel-react", () => ({
  default: (options: {
    startIndex?: number;
    watchDrag?: (
      api?: unknown,
      event?: { touches?: { length: number } },
    ) => boolean;
  }) => {
    capturedEmblaOptions = options;
    return [
      vi.fn(), // emblaRef
      {
        scrollPrev: mockScrollPrev,
        scrollNext: mockScrollNext,
        scrollTo: mockScrollTo,
        selectedScrollSnap: mockSelectedScrollSnap,
        on: mockOn,
        off: mockOff,
      },
    ];
  },
}));

// Mock useImageZoom so tests can drive isZoomed/scale and assert the resetKey
const {
  mockZoomState,
  capturedZoomResetKeys,
  mockToggleZoomAt,
  mockIsMultiTouchRef,
} = vi.hoisted(() => ({
  mockZoomState: { scale: 1, isZoomed: false },
  capturedZoomResetKeys: [] as string[],
  mockToggleZoomAt: vi.fn(),
  mockIsMultiTouchRef: { current: false },
}));

vi.mock("@/hooks/useImageZoom", () => ({
  useImageZoom: (resetKey?: string) => {
    capturedZoomResetKeys.push(resetKey ?? "");
    return {
      containerRef: { current: null },
      scale: mockZoomState.scale,
      offset: { x: 0, y: 0 },
      isZoomed: mockZoomState.isZoomed,
      isMultiTouchRef: mockIsMultiTouchRef,
      getPointerCount: () => 0,
      reset: vi.fn(),
      toggleZoomAt: mockToggleZoomAt,
      handlers: {},
      style: { transform: "none" },
    };
  },
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock("framer-motion", () => ({
  AnimatePresence: ({
    children,
    onExitComplete,
  }: {
    children: React.ReactNode;
    onExitComplete?: () => void;
  }) => {
    // Store onExitComplete for testing
    if (onExitComplete) {
      (globalThis as Record<string, unknown>).__mockOnExitComplete =
        onExitComplete;
    }
    return children;
  },
  motion: {
    div: ({
      children,
      className,
      onClick,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
    }: {
      children: React.ReactNode;
      className?: string;
      onClick?: () => void;
      onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
      onPointerUp?: React.PointerEventHandler<HTMLDivElement>;
      onPointerCancel?: React.PointerEventHandler<HTMLDivElement>;
    }) => (
      <div
        className={className}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {children}
      </div>
    ),
  },
}));

// 固定 t() 回显 key，便于断言 aria-label
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockImages = [  "https://example.com/img1.jpg",
  "https://example.com/img2.jpg",
  "https://example.com/img3.jpg",
];

describe("ImagePreview", () => {
  beforeEach(() => {
    mockScrollPrev.mockClear();
    mockScrollNext.mockClear();
    mockScrollTo.mockClear();
    mockSelectedScrollSnap.mockClear();
    mockOn.mockClear();
    mockOff.mockClear();
    mockToggleZoomAt.mockClear();
    capturedEmblaOptions = {};
    useImagePreviewStore.getState().reset();
  });

  describe("visibility", () => {
    it("should not render content when closed", () => {
      render(<ImagePreview />);

      // ImagePreview should not be visible when closed
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("should render content when open", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      // Should show buttons (close + navigation arrows)
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  /**
   * BUG regression test: Opening non-first image shows slide animation from first image
   *
   * Problem: When clicking on the 2nd or 3rd image to open preview, the preview
   * would first show the 1st image and then animate/slide to the clicked image.
   *
   * Root cause: initialIndexRef was only updated when isOpen was false, but at that
   * point the store hadn't been updated with the new currentIndex yet. So when the
   * preview opened, it used the old (stale) initialIndex value.
   *
   * Fix: Track the previous isOpen state with wasOpenRef, and update initialIndexRef
   * when isOpen transitions from false to true (i.e., when preview just opened).
   */
  describe("BUG: opening non-first image shows slide from first", () => {
    it("should initialize Embla with correct startIndex when opening at index 0", () => {
      useImagePreviewStore.getState().open(mockImages, 0);

      render(<ImagePreview />);

      expect(capturedEmblaOptions.startIndex).toBe(0);
    });

    it("should initialize Embla with correct startIndex when opening at index 1", () => {
      useImagePreviewStore.getState().open(mockImages, 1);

      render(<ImagePreview />);

      expect(capturedEmblaOptions.startIndex).toBe(1);
    });

    it("should initialize Embla with correct startIndex when opening at index 2", () => {
      useImagePreviewStore.getState().open(mockImages, 2);

      render(<ImagePreview />);

      expect(capturedEmblaOptions.startIndex).toBe(2);
    });

    it("should NOT slide from first image when opening middle image", () => {
      // This test verifies the fix for the bug where opening image at index 1
      // would first show image 0 and then slide to image 1

      useImagePreviewStore.getState().open(mockImages, 1);

      render(<ImagePreview />);

      // Embla should be initialized at index 1, not 0
      // This is the key fix - before the bug fix, startIndex would be 0
      expect(capturedEmblaOptions.startIndex).toBe(1);

      // Note: scrollTo may be called by the sync effect, but since startIndex
      // is already correct, it won't cause a visible slide animation
    });

    it("should use new startIndex when reopening at different index", () => {
      // First open at index 0
      useImagePreviewStore.getState().open(mockImages, 0);
      const { unmount } = render(<ImagePreview />);
      expect(capturedEmblaOptions.startIndex).toBe(0);

      // Close and reset
      act(() => {
        useImagePreviewStore.getState().close();
        useImagePreviewStore.getState().reset();
      });
      unmount();

      // Reopen at index 2
      useImagePreviewStore.getState().open(mockImages, 2);
      render(<ImagePreview />);

      // Should use new index, not the old one
      expect(capturedEmblaOptions.startIndex).toBe(2);
    });
  });

  /**
   * BUG regression test: Carousel slides not filling full viewport width
   *
   * Problem: When swiping between images, the previous image would still be
   * partially visible on the left edge instead of being completely off-screen.
   *
   * Root cause: The carousel container had `safe-area-x` class which adds
   * responsive padding (sm: 1rem, lg: 3rem). This made the container narrower
   * than the viewport, but each slide was set to `flex-[0_0_100%]` of the
   * container width, not the viewport width.
   *
   * Fix: Remove `safe-area-x` from the carousel container so slides fill the
   * full viewport width. Single image mode can keep safe-area-x on its inner
   * container since it doesn't use Embla carousel.
   */
  describe("BUG: carousel slides not filling full viewport width", () => {
    it("should NOT have safe-area-x class on carousel container", () => {
      useImagePreviewStore.getState().open(mockImages);

      const { container } = render(<ImagePreview />);

      // Find the carousel container (the one that wraps embla slides)
      // It should be the parent of the flex container with slide items
      const carouselContainer = container.querySelector(
        ".overflow-hidden.touch-manipulation",
      );

      // The carousel container should exist
      expect(carouselContainer).not.toBeNull();

      // Find its parent (the flex container that was causing the bug)
      const carouselWrapper = carouselContainer?.parentElement;
      expect(carouselWrapper).not.toBeNull();

      // The wrapper should NOT have safe-area-x class (this was the bug)
      expect(carouselWrapper?.className).not.toContain("safe-area-x");
    });

    it("should have slides with full width (flex-[0_0_100%])", () => {
      useImagePreviewStore.getState().open(mockImages);

      const { container } = render(<ImagePreview />);

      // Find slide containers
      const slides = container.querySelectorAll(".flex-\\[0_0_100\\%\\]");

      // Should have 3 slides
      expect(slides.length).toBe(3);

      // Each slide should NOT have responsive padding that would reduce content width
      slides.forEach((slide) => {
        // Should not have the old px-0 sm:px-2 lg:px-4 classes
        expect(slide.className).not.toContain("sm:px-2");
        expect(slide.className).not.toContain("lg:px-4");
      });
    });

    it("single image mode should have safe-area-x on its container", () => {
      // Single image doesn't use Embla carousel, so it can have safe-area-x
      useImagePreviewStore.getState().open(["https://example.com/single.jpg"]);

      const { container } = render(<ImagePreview />);

      // For single image, there should be a container with safe-area-x
      const singleImageContainer = container.querySelector(".safe-area-x");
      expect(singleImageContainer).not.toBeNull();
    });
  });

  describe("keyboard navigation", () => {
    it("should close preview on Escape key", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      expect(useImagePreviewStore.getState().isOpen).toBe(true);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("should call scrollNext on ArrowRight key", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      fireEvent.keyDown(document, { key: "ArrowRight" });

      expect(mockScrollNext).toHaveBeenCalled();
    });

    it("should call scrollPrev on ArrowLeft key", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      fireEvent.keyDown(document, { key: "ArrowLeft" });

      expect(mockScrollPrev).toHaveBeenCalled();
    });
  });

  describe("navigation arrows", () => {
    it("should show navigation arrows when multiple images", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      const buttons = screen.getAllByRole("button");
      // Should have close button + 2 arrow buttons
      const arrowButtons = buttons.filter(
        (btn) =>
          btn.className.includes("absolute") &&
          (btn.className.includes("left-4") ||
            btn.className.includes("right-4")),
      );
      expect(arrowButtons.length).toBe(2);
    });

    it("should NOT show navigation arrows for single image", () => {
      useImagePreviewStore.getState().open(["https://example.com/single.jpg"]);

      render(<ImagePreview />);

      const buttons = screen.getAllByRole("button");
      // Should only have close button
      const arrowButtons = buttons.filter(
        (btn) =>
          btn.className.includes("left-4") &&
          btn.className.includes("absolute"),
      );
      expect(arrowButtons.length).toBe(0);
    });

    it("should call emblaApi.scrollNext when clicking next arrow", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      const buttons = screen.getAllByRole("button");
      const nextButton = buttons.find(
        (btn) =>
          btn.className.includes("right-4") &&
          btn.className.includes("absolute"),
      );
      expect(nextButton).toBeDefined();

      fireEvent.click(nextButton!);
      expect(mockScrollNext).toHaveBeenCalled();
    });

    it("should call emblaApi.scrollPrev when clicking prev arrow", () => {
      useImagePreviewStore.getState().open(mockImages, 1);

      render(<ImagePreview />);

      const buttons = screen.getAllByRole("button");
      const prevButton = buttons.find(
        (btn) =>
          btn.className.includes("left-4") &&
          btn.className.includes("absolute"),
      );
      expect(prevButton).toBeDefined();

      fireEvent.click(prevButton!);
      expect(mockScrollPrev).toHaveBeenCalled();
    });
  });

  describe("image counter", () => {
    it("should display image counter for multiple images", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      expect(screen.getByText("1 / 3")).toBeDefined();
    });

    it("should NOT display image counter for single image", () => {
      useImagePreviewStore.getState().open(["https://example.com/single.jpg"]);

      render(<ImagePreview />);

      expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
    });
  });

  /**
   * Scroll lock tests - verify body scroll is locked when preview is open
   */
  describe("scroll lock", () => {
    beforeEach(() => {
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    });

    afterEach(() => {
      document.documentElement.classList.remove("mobile-document-scroll");
      Object.defineProperty(window, "scrollY", {
        value: 0,
        configurable: true,
      });
    });

    it("should lock body scroll when open (non-iOS)", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      expect(document.body.style.position).toBe("fixed");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("should unlock body scroll when closed", () => {
      useImagePreviewStore.getState().open(mockImages);

      const { unmount } = render(<ImagePreview />);

      expect(document.body.style.position).toBe("fixed");

      act(() => {
        useImagePreviewStore.getState().close();
        useImagePreviewStore.getState().reset();
      });

      unmount();

      expect(document.body.style.position).toBe("");
      expect(document.body.style.overflow).toBe("");
    });

    it("should use overflow lock (not position:fixed) in mobile document scroll mode", async () => {
      // 移动端文档滚动：html 才是滚动容器，body position:fixed 会塌陷布局导致关图跳顶。
      document.documentElement.classList.add("mobile-document-scroll");
      const scrollToMock = window.scrollTo as unknown as ReturnType<typeof vi.fn>;
      scrollToMock.mockClear();
      // 模拟打开前的滚动位置
      Object.defineProperty(window, "scrollY", {
        value: 500,
        configurable: true,
      });

      // 未打开时 mount 再卸载：清理阶段不得触发任何 scrollTo（尤其不能 scrollTo(0,0)）
      const closed = render(<ImagePreview />);
      closed.unmount();
      expect(scrollToMock).not.toHaveBeenCalled();

      useImagePreviewStore.getState().open(mockImages);
      const { unmount } = render(<ImagePreview />);

      // 打开：不设 position:fixed，改用 overflow 锁；此时也不应触发 scrollTo
      expect(document.body.style.position).toBe("");
      expect(document.documentElement.style.overflow).toBe("hidden");
      expect(document.body.style.overflow).toBe("hidden");
      expect(scrollToMock).not.toHaveBeenCalled();

      act(() => {
        useImagePreviewStore.getState().close();
        useImagePreviewStore.getState().reset();
      });
      unmount();

      // 关闭：overflow 清空、body 定位未被污染
      expect(document.documentElement.style.overflow).toBe("");
      expect(document.body.style.overflow).toBe("");
      expect(document.body.style.position).toBe("");

      // 双重 rAF 后恢复滚动位置：最后一次 scrollTo 应为 (0, 保存的 500)
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve()),
          );
        });
      });
      expect(scrollToMock).toHaveBeenCalled();
      expect(scrollToMock.mock.calls.at(-1)).toEqual([0, 500]);
      expect(scrollToMock).not.toHaveBeenCalledWith(0, 0);

      document.documentElement.classList.remove("mobile-document-scroll");
    });
  });

  describe("Embla event listeners", () => {
    it("should register event listener on emblaApi", () => {
      useImagePreviewStore.getState().open(mockImages);

      render(<ImagePreview />);

      expect(mockOn).toHaveBeenCalledWith("select", expect.any(Function));
    });

    it("should clean up event listener on unmount", () => {
      useImagePreviewStore.getState().open(mockImages);

      const { unmount } = render(<ImagePreview />);

      unmount();

      expect(mockOff).toHaveBeenCalledWith("select", expect.any(Function));
    });
  });

  describe("image zoom 接入", () => {
    beforeEach(() => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
      mockIsMultiTouchRef.current = false;
      capturedZoomResetKeys.length = 0;
    });

    it("useImageZoom 的 resetKey 随当前图片变化（换图复位缩放）", () => {
      useImagePreviewStore.getState().open(mockImages, 0);
      render(<ImagePreview />);

      expect(capturedZoomResetKeys[capturedZoomResetKeys.length - 1]).toBe(
        `0:${mockImages[0]}`,
      );

      act(() => {
        useImagePreviewStore.getState().setIndex(1);
      });

      expect(capturedZoomResetKeys[capturedZoomResetKeys.length - 1]).toBe(
        `1:${mockImages[1]}`,
      );
    });

    it("scale>1 时禁用 embla 拖拽翻页（watchDrag 返回 false）", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open(mockImages, 0);

      render(<ImagePreview />);

      expect(typeof capturedEmblaOptions.watchDrag).toBe("function");
      expect(capturedEmblaOptions.watchDrag!()).toBe(false);
    });

    it("scale===1 时允许 embla 拖拽翻页（watchDrag 返回 true）", () => {
      useImagePreviewStore.getState().open(mockImages, 0);

      render(<ImagePreview />);

      expect(capturedEmblaOptions.watchDrag!()).toBe(true);
    });

    it("双指按下时 watchDrag 返回 false（1x 捏合不被 embla 抢走）", () => {
      useImagePreviewStore.getState().open(mockImages, 0);

      render(<ImagePreview />);

      expect(
        capturedEmblaOptions.watchDrag!(undefined, {
          touches: { length: 2 },
        }),
      ).toBe(false);
      expect(
        capturedEmblaOptions.watchDrag!(undefined, {
          touches: { length: 1 },
        }),
      ).toBe(true);
    });

    it("第二指已落下但 touches 仍报 1 时，watchDrag 仍返回 false（isMultiTouchRef 兜底）", () => {
      useImagePreviewStore.getState().open(mockImages, 0);
      render(<ImagePreview />);

      expect(
        capturedEmblaOptions.watchDrag!(undefined, { touches: { length: 1 } }),
      ).toBe(true);

      mockIsMultiTouchRef.current = true;
      expect(
        capturedEmblaOptions.watchDrag!(undefined, { touches: { length: 1 } }),
      ).toBe(false);
    });

    it("scale===1 时点击图片关闭预览", async () => {
      useImagePreviewStore.getState().open(mockImages, 0);
      const { container } = render(<ImagePreview />);

      const carousel = container.querySelector(
        ".overflow-hidden.touch-manipulation",
      );
      expect(carousel).not.toBeNull();
      const image = carousel!.querySelector("img");
      expect(image).not.toBeNull();

      fireEvent.click(image!);
      // 关闭带 ~320ms 延时（给双击留取消窗口），等它触发
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 420));
      });

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("双击（两次 click）触发缩放且不关闭预览（不依赖原生 dblclick）", async () => {
      useImagePreviewStore.getState().open(mockImages, 0);
      const { container } = render(<ImagePreview />);

      const carousel = container.querySelector(
        ".overflow-hidden.touch-manipulation",
      );
      expect(carousel).not.toBeNull();
      const image = carousel!.querySelector("img");
      expect(image).not.toBeNull();

      fireEvent.click(image!);
      fireEvent.click(image!);

      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 420));
      });

      // 第二次点按已取消关闭定时器，预览应仍然打开
      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("触屏双击在 pointerup 即判定放大、不必等第二次 click（随后 click 被吞掉）", async () => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
      mockToggleZoomAt.mockClear();
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      // 单图：img 的父级就是挂了 pointerup / click / doubleclick 的 stage
      const stage = img!.parentElement!;

      // 第一次点按：pointerdown → pointerup → click（记录上一次点按，起 320ms 关闭计时）
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      fireEvent.click(img!, { clientX: 120, clientY: 120 });
      expect(mockToggleZoomAt).not.toHaveBeenCalled();

      // 第二次点按：只到 pointerup 就应判定为双击并放大（不等 click）
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);

      // 浏览器随后补发的 click 必须被吞掉：不二次切换、不重新起关闭计时
      fireEvent.click(img!, { clientX: 120, clientY: 120 });
      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 420));
      });
      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("触屏双击放大后立刻点空白仍能关闭（不被 suppress 窗口误吞）", () => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
      mockToggleZoomAt.mockClear();
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);
      const img = container.querySelector("img")!;
      const stage = img.parentElement!;

      // 第一次点按（记录上一次点按）
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      fireEvent.click(img!, { clientX: 120, clientY: 120 });
      // 第二次点按 → 双击放大，进入 500ms suppress 窗口
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);

      // 立刻点空白（stage，落点非 img）：应继续走空白关闭，立即关闭
      fireTouchPointer(stage, "pointerdown", 300, 300);
      fireEvent.click(stage, { clientX: 300, clientY: 300 });
      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("触屏双击放大后点图片本身不关闭、也不二次切换", () => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
      mockToggleZoomAt.mockClear();
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);
      const img = container.querySelector("img")!;
      const stage = img.parentElement!;

      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      fireEvent.click(img!, { clientX: 120, clientY: 120 });
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireTouchPointer(stage, "pointerup", 120, 120);
      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);

      // 立刻点图片本身：落点仍在 img，suppress 窗口内被吞，不关闭、不二次切换
      fireTouchPointer(img!, "pointerdown", 120, 120);
      fireEvent.click(img!, { clientX: 120, clientY: 120 });
      expect(mockToggleZoomAt).toHaveBeenCalledTimes(1);
      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("scale>1 时点击图片不关闭预览", async () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open(mockImages, 0);
      const { container } = render(<ImagePreview />);

      const carousel = container.querySelector(
        ".overflow-hidden.touch-manipulation",
      );
      expect(carousel).not.toBeNull();
      const image = carousel!.querySelector("img");
      expect(image).not.toBeNull();

      fireEvent.click(image!);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
      });

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });
  });

  describe("可访问性与单图拖动", () => {
    beforeEach(() => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
      capturedZoomResetKeys.length = 0;
    });

    it("关闭与左右翻页按钮都有 aria-label", () => {
      useImagePreviewStore.getState().open(mockImages, 0);
      render(<ImagePreview />);

      expect(
        screen.getByRole("button", { name: "entry.image_close" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "entry.image_prev" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "entry.image_next" }),
      ).toBeTruthy();
    });

    it("单图未放大时拖动超过阈值不关闭预览", () => {
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      const stage = img!.parentElement!;

      // 按下后横向拖动 60px 再抬起 —— 应识别为拖动，不当作点击
      fireEvent.pointerDown(stage, { clientX: 100, clientY: 100 });
      fireEvent.click(stage, { clientX: 160, clientY: 100 });

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });
  });

  describe("点击空白处关闭", () => {
    beforeEach(() => {
      mockZoomState.scale = 1;
      mockZoomState.isZoomed = false;
    });

    it("放大态点击单图 stage 空白立即关闭", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      fireEvent.click(img!.parentElement!);

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("放大态点击图片本身不关闭", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      fireEvent.click(img!);

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("pointer capture 使 click target 落到 stage 时仍按图片处理，不关闭", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      const stage = img!.parentElement!;

      fireEvent.pointerDown(img!, { clientX: 150, clientY: 150 });
      fireEvent.pointerUp(stage, { clientX: 150, clientY: 150 });
      fireEvent.click(stage, { clientX: 150, clientY: 150 });

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("多图放大态点击 embla 内层空白立即关闭", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open(mockImages);
      const { container } = render(<ImagePreview />);

      const carousel = container.querySelector(
        ".overflow-hidden.touch-manipulation",
      );
      expect(carousel).not.toBeNull();
      fireEvent.click(carousel!);

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("放大态拖动 60px 后抬起不关闭", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      const stage = img!.parentElement!;

      fireEvent.pointerDown(stage, { clientX: 100, clientY: 100 });
      fireEvent.click(stage, { clientX: 160, clientY: 100 });

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("点击页码计数区域不会关闭预览", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open(mockImages);
      render(<ImagePreview />);

      fireEvent.click(screen.getByText("1 / 3"));

      expect(useImagePreviewStore.getState().isOpen).toBe(true);
    });

    it("干净点击空白时，pointerup 清理不会抢在 click 之前", () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      const stage = img!.parentElement!;

      fireEvent.pointerDown(stage, { clientX: 195, clientY: 20 });
      fireEvent.pointerUp(stage, { clientX: 195, clientY: 20 });
      fireEvent.click(stage, { clientX: 195, clientY: 20 });

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("放大态拖动被打断后，下一次点空白仍会关闭", async () => {
      mockZoomState.scale = 2;
      mockZoomState.isZoomed = true;
      useImagePreviewStore.getState().open([mockImages[0]!]);
      const { container } = render(<ImagePreview />);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      const stage = img!.parentElement!;

      // 原生图片拖拽会把手势打断成 pointercancel，不会产生 click
      fireEvent.pointerDown(stage, { clientX: 100, clientY: 100 });
      fireEvent.pointerCancel(stage, { clientX: 160, clientY: 100 });

      // 等 pointercancel 后的延迟清理跑完
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // 旧坐标已被清空，这一次干净点击不应再被当成拖动
      fireEvent.click(stage, { clientX: 195, clientY: 20 });

      expect(useImagePreviewStore.getState().isOpen).toBe(false);
    });

    it("可缩放的预览图禁用原生拖拽", () => {
      useImagePreviewStore.getState().open(mockImages);
      const { container } = render(<ImagePreview />);

      const images = container.querySelectorAll("img");
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) {
        expect(image.draggable).toBe(false);
      }
    });
  });
});
