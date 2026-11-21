import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTargetOps } from "./useTargetOps";
import type { PluginContribution } from "./types";

/**
 * 56-16：受控 patch —— 插件只能改**宿主登记过、且允许这种改法**的控件。
 *
 * 三条规则：
 *   1. `op:"hide"` 只在 `PLUGIN_TARGETS[target].hideable` 时生效；
 *   2. `op:"replace"` 只在 `.replaceable` 时生效，同一 target 多条取第一条（并 warn）；
 *   3. 未登记的 target 一律忽略 —— 插件写个自己想的 target 名也改不动任何东西，
 *      宿主不因为插件清单变了就多出新行为（白名单是宿主的，不是插件的）。
 */
const { contributions } = vi.hoisted(() => ({
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("./useContributions", () => ({
  // 与真实实现同口径：只回这个挂点上的贡献（用例 ⑥ 断言的就是这层隔离）
  useContributions: (surface: string) =>
    contributions.current.filter((item) => item.surface === surface),
}));

function contribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "hide-mark-read",
    surface: "entry.contextmenu",
    action: "notify",
    label: "推送到手机（Bark）",
    selection: "single",
    ...overrides,
  };
}

/** 在指定挂点上跑一遍 `useTargetOps` */
function ops(surface: Parameters<typeof useTargetOps>[0] = "entry.contextmenu") {
  return renderHook(() => useTargetOps(surface)).result.current;
}

afterEach(() => {
  contributions.current = [];
  vi.restoreAllMocks();
});

describe("useTargetOps（56-16 受控 patch）", () => {
  it("① op:\"hide\" + 已登记且可隐藏的目标 → isHidden 为真", () => {
    contributions.current = [
      contribution({ op: "hide", target: "entry.mark_read" }),
    ];

    const target = ops();
    expect(target.isHidden("entry.mark_read")).toBe(true);
    // hide 不产生替代项
    expect(target.replacement("entry.mark_read")).toBeUndefined();
  });

  it("② op:\"hide\" + 未登记的目标 → 忽略（不隐藏任何东西）", () => {
    contributions.current = [
      contribution({ op: "hide", target: "entry.some_future_control" }),
    ];

    const target = ops();
    expect(target.isHidden("entry.some_future_control")).toBe(false);
    expect(target.isHidden("entry.mark_read")).toBe(false);
  });

  it("③ op:\"replace\" + 已登记且可替换的目标 → replacement 返回该贡献项", () => {
    const replace = contribution({
      id: "star-via-api",
      action: "star",
      label: "星标到稍后读",
      op: "replace",
      target: "entry.star",
    });
    contributions.current = [replace];

    const target = ops();
    expect(target.replacement("entry.star")?.id).toBe("star-via-api");
    // replace 不等于隐藏：宿主控件由调用方按 replacement 决定怎么画
    expect(target.isHidden("entry.star")).toBe(false);
  });

  it("④ op:\"replace\" + 已登记但不可替换的目标 → undefined（照旧渲染宿主项）", () => {
    contributions.current = [
      contribution({ id: "nope", op: "replace", target: "entry.mark_read" }),
    ];

    const target = ops();
    expect(target.replacement("entry.mark_read")).toBeUndefined();
    // 不可替换的目标也不能被 replace 顺手藏掉
    expect(target.isHidden("entry.mark_read")).toBe(false);
  });

  it("⑤ 同一 target 多条 replace → 取第一条，并 warn 一次（便于插件作者发现冲突）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    contributions.current = [
      contribution({ id: "first", op: "replace", target: "entry.star" }),
      contribution({ id: "second", op: "replace", target: "entry.star" }),
    ];

    const target = ops();
    expect(target.replacement("entry.star")?.id).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("⑥ 只在传入的挂点里找：别的挂点的 hide / replace 不影响本挂点", () => {
    contributions.current = [
      contribution({
        id: "from-reader",
        surface: "entry.reader.toolbar",
        op: "hide",
        target: "entry.mark_read",
      }),
    ];

    expect(ops("entry.contextmenu").isHidden("entry.mark_read")).toBe(false);
  });
});
