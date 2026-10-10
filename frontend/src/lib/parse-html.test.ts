import { describe, it, expect } from "vitest";
import { parseHtml } from "./parse-html";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { Root } from "hast";

// Helper to convert hastTree back to HTML string for easier assertion
function hastToHtml(tree: Root): string {
  const processor = unified().use(rehypeStringify);
  return processor.stringify(tree);
}

describe("parse-html", () => {
  describe("parseHtml", () => {
    it("should parse basic HTML", () => {
      const result = parseHtml("<p>Hello World</p>");
      expect(hastToHtml(result.hastTree)).toBe("<p>Hello World</p>");
    });

    it("should trim trailing br elements", () => {
      const result = parseHtml("<p>Hello</p><br><br>");
      expect(hastToHtml(result.hastTree)).toBe("<p>Hello</p>");
    });

    it("should preserve allowed media tags", () => {
      const result = parseHtml('<video src="test.mp4" controls></video>');
      expect(hastToHtml(result.hastTree)).toContain("<video");
      expect(hastToHtml(result.hastTree)).toContain("controls");
    });

    it("should remove style elements together with their CSS text", () => {
      const html =
        "<style>.bh__table { border: 1px solid #C0C0C0; }</style><p>Hello World</p>";
      const result = parseHtml(html);

      expect(hastToHtml(result.hastTree)).toBe("<p>Hello World</p>");
    });

    it("should remove head and title elements together with their text content", () => {
      const html =
        "<head><title>Newsletter title</title></head><p>Hello World</p>";
      const result = parseHtml(html);

      expect(hastToHtml(result.hastTree)).toBe("<p>Hello World</p>");
    });

    it("should remove iframe and object fallback text", () => {
      const html =
        '<iframe src="https://example.com/embed">iframe fallback</iframe><object data="movie.swf">object fallback</object><p>Hello World</p>';
      const result = parseHtml(html);

      expect(hastToHtml(result.hastTree)).toBe("<p>Hello World</p>");
    });

    it("should remove textarea raw text and legacy fallback tags", () => {
      const html = [
        "<textarea>raw <b>text</b></textarea>",
        '<noembed><img src="x">fallback</noembed>',
        '<noframes><a href="/x">legacy fallback</a></noframes>',
        "<p>Hello World</p>",
      ].join("");
      const result = parseHtml(html);

      expect(hastToHtml(result.hastTree)).toBe("<p>Hello World</p>");
    });
  });

  describe("bare URL linkify (45)", () => {
    it("把正文里的裸 URL 变成 <a>", () => {
      const result = parseHtml(
        "<p>看这个 https://github.com/WizisCool/oh-my-cpa 项目</p>",
      );
      const output = hastToHtml(result.hastTree);
      expect(output).toContain('<a href="https://github.com/WizisCool/oh-my-cpa">');
      expect(output).toContain("</a>");
    });

    it("报障条目原样：中文 + <br> + 裸 URL + <br> + <img>", () => {
      const html =
        '这是啥，外加一个可视化管理控制台。<br><br>https://github.com/WizisCool/oh-my-cpa<br><img width="2048" height="1399" src="https://pbs.twimg.com/media/HULC8jJaYAA_USP?format=jpg&amp;name=orig" referrerpolicy="no-referrer">';
      const output = hastToHtml(parseHtml(html).hastTree);
      expect(output).toContain('<a href="https://github.com/WizisCool/oh-my-cpa">');
      // 图片必须没被插件搞坏
      expect(output).toContain("<img");
      expect(output).toContain("pbs.twimg.com/media/HULC8jJaYAA_USP");
    });

    it("尾标点不进 href，但留在链接外面", () => {
      const output = hastToHtml(
        parseHtml("<p>详见 https://www.appinn.com/eggs-26917/，谢谢。</p>").hastTree,
      );
      expect(output).toContain('<a href="https://www.appinn.com/eggs-26917/">');
      expect(output).not.toContain("26917/，谢谢</a>");
    });

    it("已有 <a> 的正文不被重复包装（href 不变、只有一个 a 标签）", () => {
      const html = '<p>见 <a href="https://a.com/x">https://a.com/x</a> 完</p>';
      const output = hastToHtml(parseHtml(html).hastTree);
      // 上游已经把链接文本包成 a 了：结果里应当还是**一个** a，不是两个
      expect(output.match(/<a /g)).toHaveLength(1);
      expect(output).toContain('href="https://a.com/x"');
    });

    it("<code>/<pre> 里的 URL 不链接化", () => {
      const output = hastToHtml(
        parseHtml("<pre><code>curl https://a.com/x</code></pre>").hastTree,
      );
      expect(output).not.toContain("<a ");
      expect(output).toContain("curl https://a.com/x");
    });

    it("单个文本节点里有多个 URL 时全部链接化", () => {
      const output = hastToHtml(
        parseHtml("<p>甲 https://a.com/x 乙 https://b.dev/y</p>").hastTree,
      );
      const hrefs = [...output.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual(["https://a.com/x", "https://b.dev/y"]);
      expect(output).toContain("甲");
      expect(output).toContain("乙");
    });

    it("不上 scheme 的裸域名不猜（保持纯文本）", () => {
      const output = hastToHtml(parseHtml("<p>访问 example.com 查看</p>").hastTree);
      expect(output).not.toContain("<a ");
      expect(output).toContain("example.com");
    });
  });

  describe("emoji image conversion", () => {
    it("should convert WordPress wp-smiley emoji image to native emoji", () => {
      const html =
        '<p>Check this <img src="https://s.w.org/images/core/emoji/1.png" alt="\u2705" class="wp-smiley" style="height: 1em;"> out</p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\u2705");
      expect(output).toBe("<p>Check this \u2705 out</p>");
    });

    it("should convert EmojiOne emoji image to native emoji", () => {
      const html =
        '<p>Hello <img class="emojione" alt="\ud83d\ude00" src="https://cdn.jsdelivr.net/emojione/1f600.png"> World</p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\ud83d\ude00");
    });

    it("should convert Twemoji emoji image to native emoji", () => {
      const html =
        '<p>Love <img class="emoji" alt="\u2764\ufe0f" src="https://twemoji.maxcdn.com/heart.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\u2764");
    });

    it("should convert emoji image with emoticon class", () => {
      const html =
        '<p>Hi <img class="emoticon" alt="\ud83d\udc4b" src="wave.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\ud83d\udc4b");
    });

    it("should convert emoji image with smiley class", () => {
      const html =
        '<p>Happy <img class="smiley" alt="\ud83d\ude0a" src="smile.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\ud83d\ude0a");
    });

    it("should handle case-insensitive class matching", () => {
      const html =
        '<p>Test <img class="WP-SMILEY" alt="\u2705" src="check.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\u2705");
    });

    it("should NOT convert regular images without emoji class or URL", () => {
      const html =
        '<p>Photo <img src="https://example.com/photo.jpg" alt="A photo"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).toContain("<img");
      expect(output).toContain('src="https://example.com/photo.jpg"');
    });

    it("should NOT convert emoji-class image if alt is not an emoji", () => {
      const html =
        '<p>Icon <img class="emoji" alt="smile" src="smile.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).toContain("<img");
    });

    it("should NOT convert emoji-class image if alt is empty", () => {
      const html = '<p>Icon <img class="emoji" alt="" src="smile.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).toContain("<img");
    });

    it("should handle mixed content with emoji and regular images", () => {
      const html = `
        <p>
          Check <img class="wp-smiley" alt="\u2705" src="check.png">
          Photo <img src="photo.jpg" alt="My photo">
          Star <img class="emoji" alt="\u2b50" src="star.png">
        </p>
      `;
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      // Emoji images should be converted
      expect(output).toContain("\u2705");
      expect(output).toContain("\u2b50");
      // Regular image should be preserved
      expect(output).toContain("<img");
      expect(output).toContain("photo.jpg");
    });

    it("should handle multiple consecutive emoji images", () => {
      const html =
        '<p><img class="emoji" alt="\ud83d\udc4d" src="1.png"><img class="emoji" alt="\ud83d\udc4e" src="2.png"><img class="emoji" alt="\ud83d\udc4c" src="3.png"></p>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\ud83d\udc4d");
      expect(output).toContain("\ud83d\udc4e");
      expect(output).toContain("\ud83d\udc4c");
    });

    it("should handle emoji in nested elements", () => {
      const html =
        '<div><p><span>Hello <img class="emoji" alt="\ud83d\udc4b" src="wave.png"> World</span></p></div>';
      const result = parseHtml(html);
      const output = hastToHtml(result.hastTree);

      expect(output).not.toContain("<img");
      expect(output).toContain("\ud83d\udc4b");
    });

    it("should handle various emoji unicode ranges", () => {
      const testCases = [
        { alt: "\u2600", desc: "sun (Miscellaneous Symbols)" },
        { alt: "\u2705", desc: "check mark (Dingbats)" },
        {
          alt: "\ud83c\udf00",
          desc: "cyclone (Miscellaneous Symbols and Pictographs)",
        },
        { alt: "\ud83d\ude00", desc: "grinning face (Emoticons)" },
        { alt: "\ud83e\udd14", desc: "thinking face (Supplemental Symbols)" },
      ];

      for (const { alt, desc } of testCases) {
        const html = `<p><img class="emoji" alt="${alt}" src="emoji.png"></p>`;
        const result = parseHtml(html);
        const output = hastToHtml(result.hastTree);

        expect(output, `Failed for ${desc}`).not.toContain("<img");
        expect(output, `Failed for ${desc}`).toContain(alt);
      }
    });
  });
});
