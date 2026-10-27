import { describe, expect, it } from "vitest";
import { applyDecorations, type DecorationSpan } from "./decorations";

/**
 * 56-22：正文装饰绘制。
 *
 * 后端给的区间是**纯文本的 rune 下标**（不是 UTF-16 码元、不是字节）：一条 `😀` 算 1 个位置，
 * 所以索引一律走 `Array.from(text)`，用 `node.data.length` / `slice()` 会错位（代理对被拆成两半，
 * 后面的偏移整体串位，标注会画到别的句子上）。
 */
function span(overrides: Partial<DecorationSpan> = {}): DecorationSpan {
  return {
    plugin: "annotate",
    id: "d1",
    start: 0,
    end: 1,
    style: "highlight",
    ...overrides,
  };
}

function makeRoot(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("applyDecorations", () => {
  it("① 单区间包在正确的位置上", () => {
    const root = makeRoot("<p>Hello world</p>");

    applyDecorations(root, [span({ start: 6, end: 11 })]);

    const mark = root.querySelector(
      'mark[data-plugin="annotate"][data-decoration-id="d1"]',
    );
    expect(mark?.textContent).toBe("world");
    expect(mark?.getAttribute("data-decoration-style")).toBe("highlight");
    // 文本一个字符都不许丢
    expect(root.textContent).toBe("Hello world");
  });

  it("② 含 emoji 时按 rune 下标算，不按 UTF-16 码元", () => {
    // "a😀bc"：rune 下标 a=0 / 😀=1 / b=2 / c=3；UTF-16 下 b 在 3
    const root = makeRoot("<p>a😀bc</p>");

    applyDecorations(root, [
      span({ id: "emoji", start: 1, end: 2 }),
      span({ id: "tail", start: 3, end: 4 }),
    ]);

    expect(
      root.querySelector('mark[data-decoration-id="emoji"]')?.textContent,
    ).toBe("😀");
    expect(
      root.querySelector('mark[data-decoration-id="tail"]')?.textContent,
    ).toBe("c");
    expect(root.textContent).toBe("a😀bc");
  });

  it("③ 跨节点区间每段分别包", () => {
    const root = makeRoot("<p>Hello</p><p>world</p>");
    // 纯文本是 "Helloworld"，[3,7) = "lo" + "wo"
    applyDecorations(root, [span({ start: 3, end: 7 })]);

    const marks = Array.from(root.querySelectorAll("mark[data-plugin]"));
    expect(marks.map((mark) => mark.textContent)).toEqual(["lo", "wo"]);
    expect(marks[0]?.closest("p")?.textContent).toBe("Hello");
    expect(marks[1]?.closest("p")?.textContent).toBe("world");
  });

  it("④ 两个重叠区间都生效（外层先包，内层再包）", () => {
    const root = makeRoot("<p>abcdefgh</p>");

    applyDecorations(root, [
      span({ id: "outer", start: 0, end: 6 }),
      span({ id: "inner", start: 4, end: 8 }),
    ]);

    const outer = root.querySelector('mark[data-decoration-id="outer"]');
    expect(outer?.textContent).toBe("abcdef");
    // 内层与外层部分重叠：落在外层里的那段嵌在外层 mark 内，越界的那段在外层外面
    const inner = Array.from(
      root.querySelectorAll('mark[data-decoration-id="inner"]'),
    );
    expect(inner.map((mark) => mark.textContent).join("")).toBe("efgh");
    expect(inner[0]?.parentElement).toBe(outer);
    expect(root.textContent).toBe("abcdefgh");
  });

  it("⑤ 还原函数把 HTML 原样还回去", () => {
    const root = makeRoot("<p>Hello <b>big</b> world</p>");
    const before = root.innerHTML;

    const restore = applyDecorations(root, [
      span({ start: 0, end: 5 }),
      span({ id: "d2", start: 10, end: 15 }),
    ]);
    expect(root.querySelectorAll("mark[data-plugin]").length).toBe(2);

    restore();

    expect(root.querySelectorAll("mark").length).toBe(0);
    expect(root.innerHTML).toBe(before);
  });

  // 56-34：后端的偏移基准（htmlToPlain，块级标签补换行）与这里的 textContent 不同源，
  // 多段落正文上只按 offset 画会整体漂。插件把选中原文一起存下来，就按原文重新定位。
  it("⑥ 偏移漂了但带原文：按原文定位到正确位置", () => {
    const root = makeRoot("<p>第一段。</p><p>这只猫很可爱。</p>");
    // 后端按「第一段。\n这只猫很可爱。」算出来的 5..9，落到 DOM 上是「猫很可爱」而不是「这只」
    const painted = applyDecorations(root, [
      span({ start: 5, end: 9, data: { text: "这只" } }),
    ]);

    const mark = root.querySelector("mark[data-plugin]");
    expect(mark?.textContent).toBe("这只");

    painted();
    expect(root.innerHTML).toBe("<p>第一段。</p><p>这只猫很可爱。</p>");
  });

  it("⑦ 原文已经改了（找不到）：宁可退回 offset，也不画到无关文字", () => {
    const root = makeRoot("<p>完全换掉的正文</p>");
    const painted = applyDecorations(root, [
      span({ start: 2, end: 5, data: { text: "这只" } }),
    ]);

    expect(root.querySelector("mark[data-plugin]")?.textContent).toBe("换掉的");
    painted();
  });
});
