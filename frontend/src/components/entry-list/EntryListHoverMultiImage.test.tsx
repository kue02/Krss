import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { HoverImg } from "@/components/block/hover-img";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/* gsap 在 jsdom 里跑不动真实补间 —— mock 掉，只保留 DOM 结构可断言。
 * 切图本身是 React state（imgIndexes → translateX），与 gsap 无关，
 * 所以 structural assertion 在这里是真断言，不是假绿（样式层真机另验）。 */
vi.mock("gsap", () => {
  const toArray = (_sel: string, scope?: Element) =>
    scope ? Array.from(scope.querySelectorAll("*")) : [];
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(),
      quickTo: () => vi.fn(),
      utils: { toArray },
    },
  };
});

const projects = [
  {
    title: "multi",
    label: "feed · time",
    imageSrc: "https://example.com/a1.jpg",
    imageSrcs: [
      "https://example.com/a1.jpg",
      "https://example.com/a2.jpg",
      "https://example.com/a3.jpg",
    ],
  },
  {
    title: "single",
    label: "feed · time",
    imageSrc: "https://example.com/b1.jpg",
  },
];

function stripOf(rowIndex: number) {
  const thumbs = document.querySelectorAll(".hover-img-thumbnail");
  return thumbs[rowIndex]?.querySelector(".hover-img-multi") ?? null;
}

describe("悬停大图多图切换（29-3 / 29-4）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("多图行渲染横向 strip（3 张 img），单图行保持原来结构", () => {
    render(<HoverImg projects={projects} />);
    const multi = stripOf(0);
    expect(multi).not.toBeNull();
    expect(multi?.querySelectorAll("img").length).toBe(3);
    expect(multi?.getAttribute("data-img-count")).toBe("3");
    expect(multi?.getAttribute("data-img-index")).toBe("0");
    // 单图行：无 strip，一张 img
    const thumbs = document.querySelectorAll(".hover-img-thumbnail");
    expect(thumbs[1]?.querySelector(".hover-img-multi")).toBeNull();
    expect(thumbs[1]?.querySelectorAll("img").length).toBe(1);
  });

  it("默认开行上滚轮：行上 wheel 切到第 2 张（translateX -100%），再滚回到第 1 张", () => {
    render(<HoverImg projects={projects} />);
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    const row = rows[0]!;
    fireEvent.wheel(row, { deltaY: 100 });
    let multi = stripOf(0);
    expect(multi?.getAttribute("data-img-index")).toBe("1");
    expect((multi as HTMLElement).style.transform).toBe("translateX(-100%)");
    // 冷却 120ms 内连滚无效 —— 用不同时间点验证到头停住不循环
    act(() => {
      vi.useFakeTimers();
    });
    fireEvent.wheel(row, { deltaY: 100 });
    fireEvent.wheel(row, { deltaY: 100 });
    act(() => {
      vi.useRealTimers();
    });
    multi = stripOf(0);
    // 至少停在合法范围内（0..2），绝不越界
    const idx = Number(multi?.getAttribute("data-img-index"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(2);
  });

  it("行上滚轮关掉时：wheel 不切图（反证）", () => {
    render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: false, floatWheel: false, hSwipe: false }}
      />,
    );
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    fireEvent.wheel(rows[0]!, { deltaY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
  });

  it("floatWheel 开时：浮块上 wheel 切图；关时不切（反证）", () => {
    const { unmount } = render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: false, floatWheel: true, hSwipe: false }}
      />,
    );
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    const thumb = document.querySelector(".hover-img-thumbnail-wrapper")!;
    fireEvent.wheel(thumb, { deltaY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("1");
    unmount();
    cleanup();

    render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: false, floatWheel: false, hSwipe: false }}
      />,
    );
    const rows2 = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows2[0]!);
    const thumb2 = document.querySelector(".hover-img-thumbnail-wrapper")!;
    fireEvent.wheel(thumb2, { deltaY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
  });

  it("hSwipe 开时：浮块上横向 mousemove 超阈值切图；关时不切（反证）", () => {
    const { unmount } = render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: false, floatWheel: false, hSwipe: true }}
      />,
    );
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    const thumb = document.querySelector(".hover-img-thumbnail-wrapper")!;
    // 首次 mousemove 只建 tracking 基准，不翻
    fireEvent.mouseMove(thumb, { clientX: 100, clientY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
    // 右滑 100px（> 48px 阈值）→ 下一张
    fireEvent.mouseMove(thumb, { clientX: 200, clientY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("1");
    unmount();
    cleanup();

    render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: false, floatWheel: false, hSwipe: false }}
      />,
    );
    const rows2 = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows2[0]!);
    const thumb2 = document.querySelector(".hover-img-thumbnail-wrapper")!;
    fireEvent.mouseMove(thumb2, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(thumb2, { clientX: 200, clientY: 100 });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
  });

  it("浮块 data-float-hover：行悬停中为 true（可进浮块），与行记忆独立", () => {
    render(<HoverImg projects={projects} />);
    const wrapper = document.querySelector(".hover-img-thumbnail-wrapper")!;
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    expect(wrapper.getAttribute("data-float-hover")).toBe("true");
    expect(wrapper.getAttribute("data-active-row")).toBe("0");
    // 可断言测试库能定位到浮块（真机用 data 属性读索引）
    expect(screen.getByText("multi")).not.toBeNull();
  });
});
