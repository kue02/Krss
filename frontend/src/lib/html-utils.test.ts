import { describe, it, expect, vi } from "vitest";
import { stripHtml } from "./html-utils";

describe("html-utils", () => {
  describe("stripHtml", () => {
    it("should strip HTML tags and return plain text", () => {
      expect(stripHtml("<p>Hello <strong>World</strong></p>")).toBe(
        "Hello World",
      );
    });

    it("should handle nested tags", () => {
      expect(stripHtml("<div><p><span>Nested</span> text</p></div>")).toBe(
        "Nested text",
      );
    });

    it("should handle empty string", () => {
      expect(stripHtml("")).toBe("");
    });

    it("should handle text without HTML", () => {
      expect(stripHtml("Plain text")).toBe("Plain text");
    });

    it("should handle special characters", () => {
      expect(stripHtml("<p>&amp; &lt; &gt;</p>")).toBe("& < >");
    });

    it("should handle self-closing tags", () => {
      expect(stripHtml("Hello<br/>World")).toBe("HelloWorld");
      expect(stripHtml('Image: <img src="test.jpg" />')).toBe("Image: ");
    });

    it("should handle script and style tags", () => {
      // jsdom filters out script/style content for security
      expect(stripHtml('<script>alert("xss")</script>Hello')).toBe("Hello");
      expect(stripHtml("<style>.red{color:red}</style>Content")).toBe(
        "Content",
      );
    });

    it("should remove nested newsletter style content from summaries", () => {
      const html = [
        "<div class='beehiiv'>",
        "<style>.bh__table { border: 1px solid #C0C0C0; }</style>",
        "<div><p>Hello World</p></div>",
        "</div>",
      ].join("");

      expect(stripHtml(html)).toBe("Hello World");
    });

    it("should remove embedded fallback text from non-content tags", () => {
      const html = [
        '<iframe src="https://example.com/embed">iframe fallback</iframe>',
        '<object data="movie.swf">object fallback</object>',
        "<textarea>raw text</textarea>",
        "<p>Hello World</p>",
      ].join("");

      expect(stripHtml(html)).toBe("Hello World");
    });
  });

  describe("stripHtml · 有界 LRU 缓存（移动端性能）", () => {
    it("同一段 html 第二次返回同一结果，且不再重复 DOMParser 解析", () => {
      const html = "<p>Cache Hit <strong>Content</strong></p>";

      const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
      try {
        const first = stripHtml(html);
        const callsAfterFirst = parseSpy.mock.calls.length;

        const second = stripHtml(html);

        // 第二次：结果相同（同一份字符串），且没有再 new DOMParser 解析
        expect(second).toBe(first);
        expect(first).toBe("Cache Hit Content");
        expect(parseSpy.mock.calls.length).toBe(callsAfterFirst);
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("空串不解析、不进缓存（每次都直接返回空串）", () => {
      const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
      try {
        expect(stripHtml("")).toBe("");
        expect(stripHtml("")).toBe("");
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        parseSpy.mockRestore();
      }
    });
  });
});
