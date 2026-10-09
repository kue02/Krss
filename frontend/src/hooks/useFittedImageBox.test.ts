import { describe, expect, it } from "vitest";
import { resolveFittedBox } from "@/hooks/useFittedImageBox";

/**
 * 42-9：正文图片自适应盒子。
 *
 * 只测纯函数部分（选尺寸 + 算比例）——ResizeObserver / store 联动走真机。
 * 数值取自真机实测过的三条星标：
 *  570×299（1.905）、竖 310×480（0.645）、横 563×309（1.825）。
 */
describe("resolveFittedBox", () => {
  it("enabled=false 时完全不介入（文章视图维持 prose 原样）", () => {
    expect(
      resolveFittedBox({
        enabled: false,
        declaredWidth: 800,
        declaredHeight: 600,
        containerWidth: 563,
        viewportHeight: 900,
      }),
    ).toBeUndefined();
  });

  it("容器宽还没量到（0）不算盒子", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 600,
        containerWidth: 0,
        viewportHeight: 900,
      }),
    ).toBeUndefined();
  });

  it("尺寸未知（既无属性也无缓存）不算盒子", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        containerWidth: 563,
        viewportHeight: 900,
      }),
    ).toBeUndefined();
  });

  it("横图：铺满容器宽，高按原图比例（1221×669 @563 → 563×308）", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 1221,
        declaredHeight: 669,
        containerWidth: 563,
        viewportHeight: 900,
      }),
    ).toEqual({ width: 563, height: 308 });
  });

  it("竖长图：超过视口 2/3 就按高度反算宽度，两侧留边、零裁切", () => {
    // 800×1200，容器 563：按宽算得 845 高 > 900*2/3=600 ⇒ 高 600、宽 400
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 1200,
        containerWidth: 563,
        viewportHeight: 900,
      }),
    ).toEqual({ width: 400, height: 600 });
  });

  it("没有 width/height 属性时用 store 量到的尺寸（无属性引文图那条路）", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        measured: { width: 800, height: 420 },
        containerWidth: 570,
        viewportHeight: 900,
      }),
    ).toEqual({ width: 570, height: 299 });
  });

  it("有 width/height 属性时属性优先于缓存", () => {
    // 属性 1221×669，缓存里是脏的 100×100 ⇒ 应采信属性
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 1221,
        declaredHeight: 669,
        measured: { width: 100, height: 100 },
        containerWidth: 563,
        viewportHeight: 900,
      }),
    ).toEqual({ width: 563, height: 308 });
  });

  it("视口变矮时上限跟着收（600 → 400）", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 1200,
        containerWidth: 563,
        viewportHeight: 600,
      }),
    ).toEqual({ width: 267, height: 400 });
  });

  // ── 多图：12-11 定的「并排、等比缩小」不能因为自适应变成竖排 ──────────────
  it("同容器 2 张图：各占一半（gap 8px），比例照原图", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 420,
        containerWidth: 613,
        viewportHeight: 900,
        imageCount: 2,
      }),
    ).toEqual({ width: 303, height: 159 });
  });

  it("同容器 3 张图：各占三分之一", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 420,
        containerWidth: 613,
        viewportHeight: 900,
        imageCount: 3,
      }),
    ).toEqual({ width: 204, height: 107 });
  });

  it("同容器 4 张图也按三分之一（与画廊 rowItemWidth 同口径）", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 450,
        containerWidth: 613,
        viewportHeight: 900,
        imageCount: 4,
      }),
    ).toEqual({ width: 204, height: 115 });
  });

  it("多图不封高度上限（Folo 只对单图封顶）——矮视口下也照原比例排", () => {
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 828,
        declaredHeight: 1284,
        containerWidth: 613,
        viewportHeight: 300,
        imageCount: 2,
      }),
    ).toEqual({ width: 303, height: 469 });
  });

  it("imageCount 缺省/非法值按 1 张处理", () => {
    const base = resolveFittedBox({
      enabled: true,
      declaredWidth: 800,
      declaredHeight: 420,
      containerWidth: 613,
      viewportHeight: 900,
    });
    expect(
      resolveFittedBox({
        enabled: true,
        declaredWidth: 800,
        declaredHeight: 420,
        containerWidth: 613,
        viewportHeight: 900,
        imageCount: 0,
      }),
    ).toEqual(base);
  });
});
