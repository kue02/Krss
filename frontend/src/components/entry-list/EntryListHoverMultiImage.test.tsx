import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import gsap from "gsap";
import { HoverImg } from "@/components/block/hover-img";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/* gsap 在 jsdom 里跑不动真实补间 —— mock 掉，只保留 DOM 结构可断言。
 * 无极滚动下：连续位移走 gsap.to（断言它收到的 x 目标值），
 * data-img-index 是 React state（= Math.round(offset/width)），照常可断言。
 * jsdom 里 clientWidth 恒为 0，组件用 STRIP_WIDTH_FALLBACK = 400。
 * 一格普通滚轮 deltaY=100 × 系数 1.0 = 100px = 1/4 张。 */
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

const mockedGsapTo = () => vi.mocked(gsap.to);
/* 取最近一次 strip 位移补间的 x 目标（过滤掉浮块 scale / yPercent 等其它补间） */
function lastStripX(): number | undefined {
  const calls = mockedGsapTo().mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const vars = calls[i]?.[1] as { x?: number } | undefined;
    if (vars && typeof vars.x === "number") return vars.x;
  }
  return undefined;
}

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

describe("悬停大图多图切换（29-3 / 29-4，无极滚动）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
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

  it("小幅 wheel 只产生部分位移：一格滚轮走 1/4 张，data-img-index 仍为 0", () => {
    render(<HoverImg projects={projects} />);
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    fireEvent.wheel(rows[0]!, { deltaY: 100 });
    // 连续位移 100px 发给 gsap（≈ 1/4 张），而不是一格跳一张
    expect(lastStripX()).toBe(-100);
    // 最近一张仍是第 0 张
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
  });

  it("连续滚 3 格累加到 3/4 张 → index 进 1；停 180ms 后吸附到整张", () => {
    vi.useFakeTimers();
    render(<HoverImg projects={projects} />);
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    const row = rows[0]!;
    fireEvent.wheel(row, { deltaY: 100 });
    fireEvent.wheel(row, { deltaY: 100 });
    fireEvent.wheel(row, { deltaY: 100 });
    // offset=300px，round(300/400)=1 → index 进 1，但还没吸附（停在 3/4 处）
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("1");
    expect(lastStripX()).toBe(-300);
    // 停 180ms → 吸附到最近整张（400px）
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(lastStripX()).toBe(-400);
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("1");
  });

  it("两端夹紧不循环：往前滚到底停在末张，往回滚到底停在首张", () => {
    vi.useFakeTimers();
    render(<HoverImg projects={projects} />);
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    const row = rows[0]!;
    for (let i = 0; i < 20; i++) fireEvent.wheel(row, { deltaY: 100 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // max=(3-1)*400=800，绝不越界、不循环回 0
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("2");
    expect(lastStripX()).toBe(-800);
    // 往回滚 20 格：回到首张，不越下界
    for (let i = 0; i < 20; i++) fireEvent.wheel(row, { deltaY: -100 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
    expect(lastStripX()).toBe(-0);
  });

  it("单图行 wheel 不拦不切（行为与原来一致）", () => {
    render(<HoverImg projects={projects} />);
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[1]!);
    fireEvent.wheel(rows[1]!, { deltaY: 100 });
    // 单图行无 strip，多图行也不受影响
    const thumbs = document.querySelectorAll(".hover-img-thumbnail");
    expect(thumbs[1]?.querySelector(".hover-img-multi")).toBeNull();
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
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
    expect(lastStripX()).toBeUndefined();
  });

  it("floatWheel 开时：浮块上 wheel 连续位移；关时不切（反证）", () => {
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
    // 同样是小幅部分位移（1/4 张），index 仍 0
    expect(lastStripX()).toBe(-100);
    expect(stripOf(0)?.getAttribute("data-img-index")).toBe("0");
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

  it("浮块 data-float-hover：两个开关全关时不吃指针；开了且行悬停中才 true（反证）", () => {
    // 默认只开 rowWheel ⇒ 浮块是纯跟随预览，指针照常穿过去（不挡列表点击/滚动）
    render(<HoverImg projects={projects} />);
    const wrapper = document.querySelector(".hover-img-thumbnail-wrapper")!;
    const rows = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows[0]!);
    expect(wrapper.getAttribute("data-float-hover")).toBe("false");
    expect(wrapper.getAttribute("data-active-row")).toBe("0");
    // 可断言测试库能定位到浮块（真机用 data 属性读索引）
    expect(screen.getByText("multi")).not.toBeNull();
    cleanup();

    // floatWheel 开 + 行悬停中 ⇒ 浮块吃指针（鼠标能进去、滚轮/横滑有地方落）
    render(
      <HoverImg
        projects={projects}
        multiImageConfig={{ rowWheel: true, floatWheel: true, hSwipe: false }}
      />,
    );
    const wrapper2 = document.querySelector(".hover-img-thumbnail-wrapper")!;
    const rows2 = document.querySelectorAll(".hover-img-project");
    fireEvent.mouseEnter(rows2[0]!);
    expect(wrapper2.getAttribute("data-float-hover")).toBe("true");
    expect(wrapper2.getAttribute("data-active-row")).toBe("0");
  });
});
