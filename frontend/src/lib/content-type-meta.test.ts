import { describe, expect, it } from "vitest";
import { CONTENT_TYPE_ORDER, contentTypeMeta } from "./content-type-meta";

/**
 * 用户第十一批 11-6：订阅右键的「更改类型」要显示视图图标。
 * 图标映射抽到这里共享（中栏切换器 + 右键菜单各处一份会漂），所以这里把契约钉住：
 * 四种内容类型都要有图标与文案键，且图标互不相同（同一个类型在两处长得不一样就白抽了）。
 */
describe("contentTypeMeta", () => {
  it("四种内容类型齐全，顺序固定（文章 → 社交媒体 → 图片 → 通知）", () => {
    expect(CONTENT_TYPE_ORDER).toEqual([
      "article",
      "social",
      "picture",
      "notification",
    ]);
    for (const type of CONTENT_TYPE_ORDER) {
      expect(contentTypeMeta[type]).toBeTruthy();
    }
  });

  it("每个类型都有图标组件与文案键", () => {
    for (const type of CONTENT_TYPE_ORDER) {
      const meta = contentTypeMeta[type];
      expect(typeof meta.icon).not.toBe("undefined");
      expect(meta.labelKey.startsWith("content_type.")).toBe(true);
    }
  });

  it("图标互不相同（否则两处显示会混）", () => {
    const icons = CONTENT_TYPE_ORDER.map((type) => contentTypeMeta[type].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
