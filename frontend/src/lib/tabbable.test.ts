import { describe, expect, it } from "vitest";
import { getTabbable, getTabbableOutside, moveTabOutOfContainer } from "./tabbable";

/**
 * 1124：非模态浮窗的 Tab 出窗逻辑。
 *
 * 为什么单测这一层：Radix 的 `FocusScope` 写死 `loop: true`，Tab 会在窗内循环；
 * 这里不碰 Radix，只在 window 捕获阶段接管边界 —— 所以边界判定本身是纯 DOM 逻辑，
 * 可以用 jsdom 直接钉住（真浏览器行为另有 ego-browser 实测）。
 */
function build(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("getTabbable", () => {
  it("按 DOM 顺序收集可 Tab 元素，跳过 disabled 与 tabindex=-1", () => {
    const host = build(`
      <div role="dialog">
        <button id="a">a</button>
        <button id="b" disabled>b</button>
        <a id="c" href="#">c</a>
        <input id="d" />
        <input id="e" type="hidden" />
        <div id="f" tabindex="-1">f</div>
        <div id="g" tabindex="0">g</div>
      </div>
    `);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(getTabbable(dialog).map((element) => element.id)).toEqual([
      "a",
      "c",
      "d",
      "g",
    ]);
    host.remove();
  });

  it("display:none 的不算", () => {
    const host = build(`
      <div role="dialog">
        <button id="a">a</button>
        <button id="b" style="display:none">b</button>
      </div>
    `);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(getTabbable(dialog).map((element) => element.id)).toEqual(["a"]);
    host.remove();
  });
});

describe("getTabbableOutside", () => {
  it("排除容器内元素与 Radix 的焦点守卫 span", () => {
    const host = build(`
      <span data-radix-focus-guard tabindex="0"></span>
      <button id="outside">outside</button>
      <div role="dialog"><button id="inside">inside</button></div>
    `);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const ids = getTabbableOutside(dialog).map((element) => element.id);
    expect(ids).toContain("outside");
    expect(ids).not.toContain("inside");
    host.remove();
  });
});

describe("moveTabOutOfContainer", () => {
  /** 窗内三个可聚焦元素，窗外前后各一个 —— 用来区分「边界」与「中间」 */
  function buildThree() {
    const host = build(`
      <button id="before">before</button>
      <div role="dialog">
        <button id="in1">in1</button>
        <button id="in2">in2</button>
        <button id="in3">in3</button>
      </div>
      <button id="after">after</button>
    `);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    return { host, dialog };
  }

  it("最后一个元素往后 Tab：焦点交给窗外第一个可 Tab 元素", () => {
    const { host, dialog } = buildThree();
    document.getElementById("in3")!.focus();
    expect(moveTabOutOfContainer(dialog, false)).toBe(true);
    expect(document.activeElement?.id).toBe("before");
    host.remove();
  });

  it("第一个元素 Shift+Tab：焦点交给窗外最后一个可 Tab 元素", () => {
    const { host, dialog } = buildThree();
    document.getElementById("in1")!.focus();
    expect(moveTabOutOfContainer(dialog, true)).toBe(true);
    expect(document.activeElement?.id).toBe("after");
    host.remove();
  });

  /**
   * 审查 B1：少了边界判断时，窗内任何一次 Tab 都会把焦点扔出窗 ——
   * 打开设置后按第一次 Tab 就跳到背后页面，窗内控件全部够不到。
   */
  it("窗内中间元素 Tab / Shift+Tab：不接管，返回 false", () => {
    const { host, dialog } = buildThree();
    document.getElementById("in2")!.focus();
    expect(moveTabOutOfContainer(dialog, false)).toBe(false);
    expect(document.activeElement?.id).toBe("in2");
    expect(moveTabOutOfContainer(dialog, true)).toBe(false);
    expect(document.activeElement?.id).toBe("in2");
    host.remove();
  });

  it("窗外没有可聚焦元素时返回 false，不硬抢焦点", () => {
    const host = build(`<div role="dialog"><button id="inside">inside</button></div>`);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    document.getElementById("inside")!.focus();
    expect(moveTabOutOfContainer(dialog, false)).toBe(false);
    host.remove();
  });

  it("祖先 display:none 里的按钮不算可 Tab 目标（审查 m1）", () => {
    const host = build(`
      <div style="display:none"><button id="ghost">ghost</button></div>
      <button id="real">real</button>
      <div role="dialog"><button id="in1">in1</button><button id="in2">in2</button></div>
    `);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(getTabbableOutside(dialog).map((element) => element.id)).toEqual(["real"]);
    document.getElementById("in2")!.focus();
    expect(moveTabOutOfContainer(dialog, false)).toBe(true);
    expect(document.activeElement?.id).toBe("real");
    host.remove();
  });
});
