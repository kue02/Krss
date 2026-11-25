import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { useImageZoom } from "./useImageZoom";

const CONTAINER_WIDTH = 400;
const CONTAINER_HEIGHT = 300;

type ZoomApi = ReturnType<typeof useImageZoom>;

let latestZoom: ZoomApi | null = null;

function getZoom(): ZoomApi {
  if (!latestZoom) throw new Error("zoom hook 还没挂载");
  return latestZoom;
}

interface PointerInit {
  id: number;
  x: number;
  y: number;
  pointerType?: string;
}

/**
 * jsdom 不一定实现 PointerEvent，这里用 MouseEvent + 补属性派发；
 * React 的 pointer 事件插件只读这些字段，足够驱动状态机。
 */
function firePointer(
  element: Element,
  type: string,
  { id, x, y, pointerType = "touch" }: PointerInit,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
  });
  fireEvent(element, event);
}

function ZoomHarness({ resetKey }: { resetKey?: string }) {
  const zoom = useImageZoom(resetKey);
  useEffect(() => {
    latestZoom = zoom;
  });
  return (
    <>
      <div data-testid="zoom-container" ref={zoom.containerRef} {...zoom.handlers}>
        <img data-testid="zoom-image" ref={zoom.imageRef} alt="" style={zoom.style} />
      </div>
      <output data-testid="zoom-state">
        {`${zoom.scale}|${zoom.offset.x}|${zoom.offset.y}|${zoom.isInteracting}`}
      </output>
    </>
  );
}

function setup(resetKey?: string) {
  latestZoom = null;
  const utils = render(<ZoomHarness resetKey={resetKey} />);
  const container = screen.getByTestId("zoom-container");
  const image = screen.getByTestId("zoom-image");

  container.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: CONTAINER_WIDTH,
      bottom: CONTAINER_HEIGHT,
      width: CONTAINER_WIDTH,
      height: CONTAINER_HEIGHT,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(image, "clientWidth", {
    configurable: true,
    value: CONTAINER_WIDTH,
  });
  Object.defineProperty(image, "clientHeight", {
    configurable: true,
    value: CONTAINER_HEIGHT,
  });

  // jsdom 没有 pointer capture，手动补上以便断言
  container.setPointerCapture = vi.fn();
  container.hasPointerCapture = vi.fn(() => false);

  return {
    container,
    image,
    read: () => screen.getByTestId("zoom-state").textContent ?? "",
    rerenderKey: (next: string) =>
      utils.rerender(<ZoomHarness resetKey={next} />),
    // 用同样的 props 重渲染，模拟父组件因无关状态（onLoad/已读/翻译）触发的 render
    rerenderSame: () => utils.rerender(<ZoomHarness resetKey={resetKey} />),
  };
}

describe("useImageZoom", () => {
  afterEach(cleanup);

  it("toggleZoomAt 在 1x 时放大到 2x，再调用一次复位到 1x", () => {
    const { read } = setup();
    expect(read()).toBe("1|0|0|false");

    act(() => getZoom().toggleZoomAt(200, 150));
    expect(read()).toBe("2|0|0|false");

    act(() => getZoom().toggleZoomAt(200, 150));
    expect(read()).toBe("1|0|0|false");
  });

  it("第二根手指按下后，pointermove 不会把单指位移叠加成平移", () => {
    const { container, read, image } = setup();

    // 第一根手指按下（1x 不进入拖动），第二根进入捏合
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 150, y: 150 });
      firePointer(container, "pointerdown", { id: 2, x: 250, y: 150 });
    });
    expect(read()).toBe("1|0|0|true");
    expect(image.style.transition).toBe("none");

    // 两指同时平移 10px、间距不变：只应保持缩放，不该产生平移
    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 160, y: 150 });
      firePointer(container, "pointermove", { id: 2, x: 260, y: 150 });
    });
    expect(read()).toBe("1|0|0|true");
    expect(image.style.transform).toContain("translate3d(0px, 0px, 0)");
  });

  it("双指捏合按两指中点缩放，锚点保持不动", () => {
    const { container, image, read } = setup();

    // 中点 x=300（相对容器中心 +100），初始间距 100
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 250, y: 150 });
      firePointer(container, "pointerdown", { id: 2, x: 350, y: 150 });
    });
    // 间距拉到 200 → 2x；锚点 100 处保持不动 → offset = -100
    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 2, x: 400, y: 150 });
    });

    // 手势中只写 DOM，state 要等抬手才提交
    expect(image.style.transform).toBe(
      "translate3d(-100px, 0px, 0) scale(2)",
    );

    act(() => {
      firePointer(container, "pointerup", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointerup", { id: 2, x: 400, y: 150 });
    });
    expect(read()).toBe("2|-100|0|false");
  });

  it("双指结束后剩下的一根手指可以继续平移，抬起后提交并恢复缓动", () => {
    const { container, read, image } = setup();

    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 150, y: 150 });
      firePointer(container, "pointerdown", { id: 2, x: 250, y: 150 });
    });
    // 间距从 100 拉到 200 → 2x，中点在容器中心 → 无平移
    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 100, y: 150 });
      firePointer(container, "pointermove", { id: 2, x: 300, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");
    expect(read()).toBe("1|0|0|true");

    // 抬起第二根手指，第一根继续拖 30px
    act(() => {
      firePointer(container, "pointerup", { id: 2, x: 300, y: 150 });
    });
    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 130, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(30px, 0px, 0) scale(2)");
    expect(image.style.transition).toBe("none");

    act(() => {
      firePointer(container, "pointerup", { id: 1, x: 130, y: 150 });
    });
    expect(read()).toBe("2|30|0|false");
    expect(image.style.transition).toBe("transform 240ms cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("手势中父组件重渲染不会把手势里已 paint 的 transform 覆盖回旧 state", () => {
    const { container, image, read, rerenderSame } = setup();

    // 先放大到 2x（提交态 offset=0）
    act(() => getZoom().toggleZoomAt(200, 150));
    expect(read()).toBe("2|0|0|false");

    // 放大后拖动 60px：paint 只写 DOM，state 仍是提交态
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 260, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(60px, 0px, 0) scale(2)");

    // 父组件重渲染（模拟 onLoad / 已读状态 / 翻译等）：React 会重写 style.transform
    act(() => {
      rerenderSame();
    });

    // 关键：仍然是手势里的实时值，而不是回跳到 offset=0
    expect(image.style.transform).toBe("translate3d(60px, 0px, 0) scale(2)");
    // state 本身还是提交态（未抬手提交）
    expect(read()).toBe("2|0|0|true");

    // 抬手后正常提交
    act(() => {
      firePointer(container, "pointerup", { id: 1, x: 260, y: 150 });
    });
    expect(read()).toBe("2|60|0|false");
    expect(image.style.transform).toBe("translate3d(60px, 0px, 0) scale(2)");
  });

  it("resetKey 变化时复位缩放", () => {
    const { read, rerenderKey } = setup("0:a");

    act(() => getZoom().toggleZoomAt(200, 150));
    expect(read()).toBe("2|0|0|false");

    act(() => rerenderKey("1:b"));
    expect(read()).toBe("1|0|0|false");
  });

  it("scale===1 的普通 pointerdown 不 capture，避免抢走 click", () => {
    const { container } = setup();
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 150, y: 150 });
    });
    expect(container.setPointerCapture).not.toHaveBeenCalled();
  });

  it("第二根手指进入捏合时才 capture 两根手指", () => {
    const { container } = setup();
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 150, y: 150 });
    });
    expect(container.setPointerCapture).not.toHaveBeenCalled();

    act(() => {
      firePointer(container, "pointerdown", { id: 2, x: 250, y: 150 });
    });
    expect(container.setPointerCapture).toHaveBeenCalledWith(1);
    expect(container.setPointerCapture).toHaveBeenCalledWith(2);
  });

  it("放大后开始拖动才 capture", () => {
    const { container } = setup();
    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
    });
    expect(container.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("lostpointercapture 会恢复手势开始前的状态，不提交中间位移", () => {
    const { container, image, read } = setup();
    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 260, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(60px, 0px, 0) scale(2)");

    act(() => {
      firePointer(container, "lostpointercapture", { id: 1, x: 260, y: 150 });
    });
    expect(read()).toBe("2|0|0|false");
    expect(image.style.transition).toBe("transform 240ms cubic-bezier(0.22, 1, 0.36, 1)");
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");

    // 指针已清空，后续 pointermove 不再生效
    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 320, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");
  });

  it("pointercancel 会回滚到手势开始前的状态，不提交中间位移", () => {
    const { container, image, read } = setup();
    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 250, y: 150 });
    });
    // 拖动中：画面确实已跟手到 50px
    expect(image.style.transform).toBe("translate3d(50px, 0px, 0) scale(2)");

    act(() => {
      firePointer(container, "pointercancel", { id: 1, x: 250, y: 150 });
    });
    // 系统取消应回滚到手势开始快照（scale=2, offset=0），而不是把 50px 当最终值
    expect(read()).toBe("2|0|0|false");
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");
    expect(image.style.transition).toBe("transform 240ms cubic-bezier(0.22, 1, 0.36, 1)");

    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 300, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");
  });

  it("图片未加载（clientWidth=0）时不允许拖出，onLoad 后恢复", () => {
    const { container, image, read } = setup();
    Object.defineProperty(image, "clientWidth", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(image, "clientHeight", {
      configurable: true,
      value: 0,
    });

    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 300, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(0px, 0px, 0) scale(2)");

    act(() => {
      firePointer(container, "pointerup", { id: 1, x: 300, y: 150 });
    });
    expect(read()).toBe("2|0|0|false");

    Object.defineProperty(image, "clientWidth", {
      configurable: true,
      value: CONTAINER_WIDTH,
    });
    Object.defineProperty(image, "clientHeight", {
      configurable: true,
      value: CONTAINER_HEIGHT,
    });
    act(() => getZoom().onImageLoad());

    act(() => {
      firePointer(container, "pointerdown", { id: 2, x: 200, y: 150 });
      firePointer(container, "pointermove", { id: 2, x: 260, y: 150 });
    });
    expect(image.style.transform).toBe("translate3d(60px, 0px, 0) scale(2)");
  });

  it("第二指按下后 isMultiTouchRef / getPointerCount 实时反映多指状态", () => {
    const { container } = setup();
    expect(getZoom().getPointerCount()).toBe(0);
    expect(getZoom().isMultiTouchRef.current).toBe(false);

    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 150, y: 150 });
    });
    expect(getZoom().getPointerCount()).toBe(1);
    expect(getZoom().isMultiTouchRef.current).toBe(false);

    act(() => {
      firePointer(container, "pointerdown", { id: 2, x: 250, y: 150 });
    });
    expect(getZoom().getPointerCount()).toBe(2);
    expect(getZoom().isMultiTouchRef.current).toBe(true);

    act(() => {
      firePointer(container, "pointerup", { id: 2, x: 250, y: 150 });
      firePointer(container, "pointerup", { id: 1, x: 150, y: 150 });
    });
    expect(getZoom().getPointerCount()).toBe(0);
    expect(getZoom().isMultiTouchRef.current).toBe(false);
  });

  it("拖动期间复用缓存的尺寸，pointermove 不再触发强制布局", () => {
    const { container, image } = setup();
    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", { id: 1, x: 200, y: 150 });
    });

    // 手势已开始（beginDrag 已刷新缓存），此后统计布局读取
    const originalRect = container.getBoundingClientRect.bind(container);
    const rectSpy = vi.fn(originalRect);
    container.getBoundingClientRect = rectSpy;

    act(() => {
      firePointer(container, "pointermove", { id: 1, x: 240, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 280, y: 150 });
      firePointer(container, "pointermove", { id: 1, x: 320, y: 150 });
    });

    // 逐帧移动只读缓存，不应再调用 getBoundingClientRect
    expect(rectSpy).not.toHaveBeenCalled();
    expect(image.style.transform).toBe("translate3d(120px, 0px, 0) scale(2)");
  });

  it("鼠标拖出容器兜底结束拖动时会恢复 transition", () => {
    const { container, image } = setup();
    act(() => getZoom().toggleZoomAt(200, 150));
    act(() => {
      firePointer(container, "pointerdown", {
        id: 1,
        x: 200,
        y: 150,
        pointerType: "mouse",
      });
      firePointer(container, "pointermove", {
        id: 1,
        x: 240,
        y: 150,
        pointerType: "mouse",
      });
    });
    expect(image.style.transition).toBe("none");

    act(() => {
      // hasPointerCapture 被 mock 成 false → 走鼠标兜底结束。
      // 直接调 handler：jsdom 里 onPointerLeave 由 pointerout 合成，裸 pointerleave 不触发。
      getZoom().handlers.onPointerLeave?.({
        pointerId: 1,
        pointerType: "mouse",
        clientX: 240,
        clientY: 150,
      } as unknown as import("react").PointerEvent);
    });
    expect(image.style.transition).toBe(
      "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)",
    );
  });
});
