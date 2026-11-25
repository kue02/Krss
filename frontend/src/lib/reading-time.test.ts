import { describe, expect, it } from "vitest";
import { estimateReadingMinutes } from "./reading-time";

describe("estimateReadingMinutes", () => {
  it("无内容返回 null", () => {
    expect(estimateReadingMinutes(null)).toBeNull();
    expect(estimateReadingMinutes(undefined)).toBeNull();
    expect(estimateReadingMinutes("")).toBeNull();
  });

  it("纯标签 / 空白按无内容处理", () => {
    expect(estimateReadingMinutes("<p></p>")).toBeNull();
  });

  it("纯中文短文本算 1 分钟", () => {
    expect(estimateReadingMinutes("修复了部分错误")).toBe(1);
  });

  it("长中文 HTML（含标签）字数超过 230 时至少 2 分钟", () => {
    const longChinese = `<p>${"阅读".repeat(120)}</p>`;
    const mins = estimateReadingMinutes(longChinese);
    expect(mins).not.toBeNull();
    expect(mins as number).toBeGreaterThanOrEqual(2);
  });

  it("英文按词计数", () => {
    // 230 个单词 → 1 分钟；231 个 → 2 分钟
    expect(estimateReadingMinutes(Array.from({ length: 230 }, () => "word").join(" "))).toBe(1);
    expect(estimateReadingMinutes(Array.from({ length: 231 }, () => "word").join(" "))).toBe(2);
  });

  it("去除标签后不计标签内文字", () => {
    // 标签本身不应被计入，只统计文本
    const html = "<div><p>hello</p><p>world</p></div>";
    expect(estimateReadingMinutes(html)).toBe(1);
  });
});
