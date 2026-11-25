import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInView } from "./useInView";

/** 最小探针：把 useInView 的 ref 绑到一个真实 div 上，并把 inView 写成 data 属性。 */
function Probe({ rootMargin }: { rootMargin?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>(rootMargin);
  return createElement("div", {
    ref,
    "data-testid": "probe",
    "data-inview": inView ? "1" : "0",
  });
}

function readInView(): string | null {
  return document.querySelector('[data-testid="probe"]')?.getAttribute("data-inview") ?? null;
}

describe("useInView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("没有 IntersectionObserver 时首帧即 inView=true（fallback 显示真实内容）", () => {
    vi.stubGlobal("IntersectionObserver", undefined);

    render(createElement(Probe, {}));

    expect(readInView()).toBe("1");
  });

  it("有 IntersectionObserver 时初始 false，进入视口后翻转为 true", () => {
    let callback: IntersectionObserverCallback | undefined;

    class FakeIntersectionObserver {
      root = null;
      rootMargin = "";
      thresholds: number[] = [];
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    vi.stubGlobal(
      "IntersectionObserver",
      FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    );

    render(createElement(Probe, { rootMargin: "600px" }));

    expect(readInView()).toBe("0");

    act(() => {
      callback?.(
        [
          {
            isIntersecting: true,
            target: document.querySelector('[data-testid="probe"]'),
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    expect(readInView()).toBe("1");
  });
});
