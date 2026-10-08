import { describe, expect, it } from "vitest";
import {
  computeSingleBox,
  extractContentMedia,
  gridColumns,
  isSameRatio,
  rowItemWidth,
} from "./extract-content-media";

describe("extractContentMedia", () => {
  it("读取 <img> 上的 width/height", () => {
    const html = '<p>文字</p><img width="1964" height="842" src="https://pbs.twimg.com/media/a.jpg">';
    const result = extractContentMedia(html);
    expect(result).toEqual([
      { src: "https://pbs.twimg.com/media/a.jpg", width: 1964, height: 842 },
    ]);
  });

  it("缺尺寸时 width/height 为 undefined（不是 0）", () => {
    const result = extractContentMedia('<img src="https://cdn5.telesco.pe/file/x.jpg">');
    expect(result).toEqual([{ src: "https://cdn5.telesco.pe/file/x.jpg" }]);
  });

  it("width=0 / height=0 视作未知（Telegram 的「无尺寸」写法）", () => {
    const result = extractContentMedia(
      '<img width="0" height="0" src="https://cdn5.telesco.pe/file/x.jpg">',
    );
    expect(result[0]?.width).toBeUndefined();
    expect(result[0]?.height).toBeUndefined();
  });

  it("解 HTML 实体：&amp; → &（否则 thumbnail 与正文首图比不上，会渲染两次）", () => {
    const html = '<img width="10" height="10" src="https://pbs.twimg.com/media/X?format=jpg&amp;name=orig">';
    const result = extractContentMedia(html, undefined, "https://pbs.twimg.com/media/X?format=jpg&name=orig");
    expect(result).toHaveLength(1);
    expect(result[0]?.src).toBe("https://pbs.twimg.com/media/X?format=jpg&name=orig");
    expect(result[0]?.width).toBe(10);
  });

  it("thumbnail_url 命中正文首图时丢掉 thumbnail（保留带尺寸的正文那份）", () => {
    const html = '<img width="800" height="600" src="https://example.com/a.jpg">';
    const result = extractContentMedia(html, undefined, "https://example.com/a.jpg");
    expect(result).toEqual([{ src: "https://example.com/a.jpg", width: 800, height: 600 }]);
  });

  it("thumbnail_url 与正文首图 query 不同也按同一张（比较时去掉 query）", () => {
    const html = '<img src="https://example.com/a.jpg?w=100">';
    const result = extractContentMedia(html, undefined, "https://example.com/a.jpg?w=800");
    expect(result).toHaveLength(1);
  });

  it("thumbnail_url 不在正文里时作为第一张补进来", () => {
    const result = extractContentMedia("<p>纯文字</p>", undefined, "https://example.com/t.jpg");
    expect(result).toEqual([{ src: "https://example.com/t.jpg" }]);
  });

  it("正文为空时退化成只有 thumbnail", () => {
    expect(extractContentMedia("", undefined, "https://example.com/t.jpg")).toEqual([
      { src: "https://example.com/t.jpg" },
    ]);
    expect(extractContentMedia(null)).toEqual([]);
  });

  it("去重：正文里同一张图出现两次只留一个", () => {
    const html =
      '<img src="https://example.com/a.jpg"><img src="https://example.com/a.jpg?v=2">';
    expect(extractContentMedia(html)).toHaveLength(1);
  });

  it("丢弃 data: / blob: 与无法解析的地址", () => {
    const html =
      '<img src="data:image/png;base64,AAA"><img src="blob:http://x/y">' +
      '<img src="not a url"><img src="https://example.com/ok.jpg">';
    const result = extractContentMedia(html);
    expect(result).toEqual([{ src: "https://example.com/ok.jpg" }]);
  });

  it("协议相对 //host/path 补成 https:", () => {
    const result = extractContentMedia('<img src="//example.com/a.jpg">');
    expect(result[0]?.src).toBe("https://example.com/a.jpg");
  });

  it("站点绝对路径 /a.jpg 用条目地址补全", () => {
    const result = extractContentMedia('<img src="/a.jpg">', "https://site.tld/post/1");
    expect(result[0]?.src).toBe("https://site.tld/a.jpg");
  });

  it("data-src 优先于 src（懒加载站）", () => {
    const html = '<img src="https://cdn/placeholder.gif" data-src="https://cdn/real.jpg">';
    expect(extractContentMedia(html)[0]?.src).toBe("https://cdn/real.jpg");
  });

  it("非 <img>（figure/picture 里的也认 img 本身）不影响解析", () => {
    const html =
      '<figure><picture><img width="4" height="3" src="https://example.com/a.webp"></picture><figcaption>说明</figcaption></figure>';
    expect(extractContentMedia(html)).toEqual([
      { src: "https://example.com/a.webp", width: 4, height: 3 },
    ]);
  });
});

describe("isSameRatio", () => {
  it("单图 / 空数组恒为 true", () => {
    expect(isSameRatio([])).toBe(true);
    expect(isSameRatio([{ src: "a", width: 10, height: 20 }])).toBe(true);
  });

  it("同比例（严格相等）→ true", () => {
    expect(
      isSameRatio([
        { src: "a", width: 100, height: 200 },
        { src: "b", width: 50, height: 100 },
      ]),
    ).toBe(true);
  });

  it("0.5% 内的舍入差算同比例（1/3 vs 0.3333）", () => {
    expect(
      isSameRatio([
        { src: "a", width: 3, height: 1 },
        { src: "b", width: 300, height: 100 },
        { src: "c", width: 1000, height: 333 },
      ]),
    ).toBe(true);
  });

  it("比例不同 → false（Folo 走 grid 分支）", () => {
    expect(
      isSameRatio([
        { src: "a", width: 100, height: 200 },
        { src: "b", width: 100, height: 100 },
      ]),
    ).toBe(false);
  });

  it("任一张缺尺寸 → false（allowUnknownRatio 默认关）", () => {
    expect(
      isSameRatio([{ src: "a", width: 100, height: 200 }, { src: "b" }]),
    ).toBe(false);
  });

  it("allowUnknownRatio=true 时缺尺寸也放过", () => {
    expect(
      isSameRatio([{ src: "a", width: 100, height: 200 }, { src: "b" }], true),
    ).toBe(true);
  });
});

describe("gridColumns", () => {
  it("2~4 张两列、5+ 三列（Folo media-gallery.tsx:115-121）", () => {
    expect(gridColumns(2)).toBe(2);
    expect(gridColumns(3)).toBe(2);
    expect(gridColumns(4)).toBe(2);
    expect(gridColumns(5)).toBe(3);
    expect(gridColumns(9)).toBe(3);
  });
});

describe("computeSingleBox", () => {
  it("不超上限：宽=容器宽，高按比例", () => {
    const box = computeSingleBox(600, 1964, 842, 600);
    expect(box.width).toBe(600);
    expect(box.height).toBeCloseTo(257, 0);
  });

  it("超上限：改成高=上限、宽按比例收（两侧留边，零裁切）", () => {
    // 2.56:1 的竖长图，600 宽时会到 1538px 高
    const box = computeSingleBox(600, 799, 2048, 600);
    expect(box.height).toBe(600);
    expect(box.width).toBeCloseTo(234, 0);
    expect(box.width).toBeLessThan(600);
  });

  it("刚好等于上限时不触发反算", () => {
    expect(computeSingleBox(100, 1, 2, 200)).toEqual({ width: 100, height: 200 });
  });
});

describe("rowItemWidth", () => {
  it("1 张满宽 / 2 张半宽（减 8px gap）/ 3+ 张三分之一", () => {
    expect(rowItemWidth(1, 600)).toBe(600);
    expect(rowItemWidth(2, 600)).toBe(296);
    expect(rowItemWidth(3, 600)).toBe(200);
    expect(rowItemWidth(5, 600)).toBe(200);
  });
});