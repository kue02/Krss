import { describe, it, expect } from "vitest";
import { findBareUrls, stripLeadingDecorations } from "./linkify-text";

/** 取第 i 个匹配（tsc 不知道非空，测试里用辅助函数表达意图） */
function hrefAt(text: string, i = 0): string {
  const out = findBareUrls(text);
  expect(out.length, `应有第 ${i} 个匹配：${JSON.stringify(out)}`).toBeGreaterThan(i);
  return out[i]!.href;
}

describe("findBareUrls", () => {
  it("认出一个孤立的 https 链接", () => {
    const url = "https://github.com/WizisCool/oh-my-cpa";
    const out = findBareUrls(url);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ href: url, start: 0, end: url.length });
  });

  it("报障条目那种「中文 + URL」的形态（正文明文里 URL 前有分隔）", () => {
    const url = "https://github.com/WizisCool/oh-my-cpa";
    const text = `这是啥，外加一个可视化管理控制台。${url}`;
    const out = findBareUrls(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.href).toBe(url);
    expect(text.slice(out[0]!.start, out[0]!.end)).toBe(url);
    expect(text.slice(0, out[0]!.start)).toContain("可视化管理控制台。");
  });

  it("一段文本里有多个 URL，按顺序都给", () => {
    const text = "见 https://a.com/x 与 https://b.dev/y?p=1。";
    const out = findBareUrls(text);
    expect(out.map((m) => m.href)).toEqual(["https://a.com/x", "https://b.dev/y?p=1"]);
  });

  it("中文紧跟 URL 时不把空格后的内容吞进来", () => {
    expect(hrefAt("看 https://t.me/taiyin101 这里是我阅读的注脚")).toBe(
      "https://t.me/taiyin101",
    );
  });

  it("修剪尾部句读，不把句子标点算进 URL", () => {
    expect(hrefAt("详见 https://www.appinn.com/eggs-26917/，谢谢。")).toBe(
      "https://www.appinn.com/eggs-26917/",
    );
  });

  it("修剪右括号/右引号，URL 后面跟中文全角标点也能切断", () => {
    const cases = [
      "（见 https://a.com/x）",
      "他说「https://a.com/x」。",
      "链接：https://a.com/x。",
      "看 https://a.com/x、以及别的",
    ];
    for (const text of cases) {
      expect(hrefAt(text), text).toBe("https://a.com/x");
    }
  });

  it("单引号是合法 URL 字符，不能当尾标点去掉", () => {
    expect(hrefAt("仓库 https://github.com/o/r's 里有")).toBe("https://github.com/o/r's");
  });

  it("尾部的 # 与 ? 保留（锚点/查询是 URL 的一部分）", () => {
    expect(hrefAt("跳 https://a.com/p?a=1&b=2#frag 完")).toBe("https://a.com/p?a=1&b=2#frag");
  });

  it("端口、IPv4、localhost、[IPv6] 都算合法 host", () => {
    expect(hrefAt("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(hrefAt("http://192.168.5.7:8080/a")).toBe("http://192.168.5.7:8080/a");
    expect(hrefAt("http://[::1]:9000/a")).toBe("http://[::1]:9000/a");
  });

  it("host 没有点 / TLD 太短 / scheme 后什么都没有：都不算（挡残句）", () => {
    expect(findBareUrls("scheme https:// 说明")).toHaveLength(0);
    expect(findBareUrls("schema https://a。")).toHaveLength(0);
    // 端口串不能被误当域名
    expect(findBareUrls("见 http://192.168.1 端口")).toHaveLength(0);
  });

  it("大小写混合与 http 都认", () => {
    expect(hrefAt("HTTPS://A.COM/Path")).toBe("HTTPS://A.COM/Path");
    expect(hrefAt("http://a.dev/x")).toBe("http://a.dev/x");
  });

  it("没有 URL 时返回空；相对路径不猜", () => {
    expect(findBareUrls("普通一段中文，没有任何链接")).toHaveLength(0);
    expect(findBareUrls("")).toHaveLength(0);
    expect(findBareUrls("/api/entries?page=1")).toHaveLength(0);
  });
});

describe("stripLeadingDecorations", () => {
  it("去掉左引号/左括号", () => {
    expect(stripLeadingDecorations("<https://a.com>")).toBe("https://a.com>");
    expect(stripLeadingDecorations("「https://a.com」")).toBe("https://a.com」");
    expect(stripLeadingDecorations("(https://a.com)")).toBe("https://a.com)");
  });

  it("本来就没有装饰时原样", () => {
    expect(stripLeadingDecorations("https://a.com")).toBe("https://a.com");
  });
});
