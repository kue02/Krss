import { describe, expect, it } from "vitest";
import {
  clampWallOffset,
  collectWallPhotos,
  WALL_MAX_TILES,
  wallAtlasSide,
  wallFitRect,
  wallGridLayout,
  wallGridWorld,
  wallViewWorld,
} from "./picture-wall";

/**
 * 31-1 照片墙的纯计算（脱离 three.js 可测）。
 * 这些数字是 shader 里 `worldCoord = distortedUV * aspect * zoom + uOffset` 的换算结果，
 * 改 shader 的世界坐标约定就要同步改这里。
 */
describe("picture-wall 纯计算", () => {
  it("网格形状：按张数与容器宽高比挑，行数向上取整盖满", () => {
    // 120 张、容器 1.6:1 → cols = round(√192) = 14 → rows = ceil(120/14) = 9
    expect(wallGridLayout(120, 1.6)).toEqual({ cols: 14, rows: 9, cells: 126 });
    expect(wallGridLayout(1, 1.6)).toEqual({ cols: 1, rows: 1, cells: 1 });
    // 0 张兜底成 1×1；非法宽高比按默认 1.6 算（9 张 ⇒ cols=round(√14.4)=4、rows=ceil(9/4)=3）
    expect(wallGridLayout(0, 1.6)).toEqual({ cols: 1, rows: 1, cells: 1 });
    expect(wallGridLayout(9, 0)).toEqual({ cols: 4, rows: 3, cells: 12 });
  });

  it("图集边长 = ceil(√张数)（原件公式）", () => {
    expect(wallAtlasSide(25)).toBe(5);
    expect(wallAtlasSide(26)).toBe(6);
    expect(wallAtlasSide(120)).toBe(11);
    expect(wallAtlasSide(0)).toBe(1);
  });

  it("视口/网格的世界尺寸：视口 = 2*aspect*zoom × 2*zoom", () => {
    expect(wallViewWorld(1600, 800, 1)).toEqual({ w: 4, h: 2 });
    expect(wallViewWorld(1600, 800, 1.25)).toEqual({ w: 5, h: 2.5 });
    expect(wallGridWorld({ cols: 14, rows: 9, cells: 126 }, 0.75)).toEqual({
      w: 10.5,
      h: 6.75,
    });
  });

  it("偏移夹紧：拖到网格边界就停；网格比视口小则居中不动", () => {
    const grid = { w: 10.5, h: 6.75 };
    const view = { w: 4, h: 2 };
    // maxX = (10.5-4)/2 = 3.25、maxY = (6.75-2)/2 = 2.375
    expect(clampWallOffset({ x: 0, y: 0 }, grid, view)).toEqual({ x: 0, y: 0 });
    expect(clampWallOffset({ x: 99, y: -99 }, grid, view)).toEqual({
      x: 3.25,
      y: -2.375,
    });
    expect(clampWallOffset({ x: -1.5, y: 1.5 }, grid, view)).toEqual({
      x: -1.5,
      y: 1.5,
    });
    // 网格比视口小 ⇒ 只能居中
    expect(
      clampWallOffset({ x: 5, y: 5 }, { w: 2, h: 1 }, { w: 4, h: 2 }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("完整缩放（contain，不裁切）：长边贴格、短边留黑居中", () => {
    // 32-2 用户要求「不被裁剪」⇒ 横图 2000×1000 在 512 方格里上下留黑（512 × 256）
    expect(wallFitRect(2000, 1000, 512)).toEqual({
      dx: 0,
      dy: 128,
      dw: 512,
      dh: 256,
    });
    // 竖图 1000×2000 → 左右留黑（256 × 512）
    expect(wallFitRect(1000, 2000, 512)).toEqual({
      dx: 128,
      dy: 0,
      dw: 256,
      dh: 512,
    });
    // 正方图正好铺满
    expect(wallFitRect(800, 800, 512)).toEqual({
      dx: 0,
      dy: 0,
      dw: 512,
      dh: 512,
    });
    // 脏数据不炸
    expect(wallFitRect(0, 0, 512)).toEqual({ dx: 0, dy: 0, dw: 0, dh: 0 });
  });

  it("收照片：去重（忽略代理的 ?ref）+ 封顶", () => {
    expect(
      collectWallPhotos([
        "/api/proxy/image/AAA?ref=https%3A%2F%2Fx.com%2Fa",
        "/api/proxy/image/BBB?ref=https%3A%2F%2Fx.com%2Fb",
        // 同一张图从另一条条目来（ref 不同）⇒ 仍算重复
        "/api/proxy/image/AAA?ref=https%3A%2F%2Fx.com%2Fc",
        "",
      ]),
    ).toEqual([
      "/api/proxy/image/AAA?ref=https%3A%2F%2Fx.com%2Fa",
      "/api/proxy/image/BBB?ref=https%3A%2F%2Fx.com%2Fb",
    ]);

    const many = Array.from({ length: 200 }, (_, i) => `/img/${i}.jpg`);
    expect(collectWallPhotos(many)).toHaveLength(WALL_MAX_TILES);
    expect(collectWallPhotos(many)[0]).toBe("/img/0.jpg");
  });
});
