import { describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar";

/**
 * 侧栏 2026-11-25 起常驻挂载（`ui/sheet.tsx` 不再随开关卸载），所以 App 每次重渲染
 * 都会重建 `<Sidebar>` 元素。memo 是「无关重渲染不再带动这棵 1616 行的树」的唯一保障，
 * 一旦有人把导出改回普通函数组件，这条用例会立刻失败。
 *
 * 真渲染 Sidebar 需要 Auth / react-query / Router / i18n 等一大串 provider，而 memo 的
 * 语义完全由外层包装决定 —— 这里断言「导出的是 memo 组件、且里面包的是真实现」，
 * 至于 props 是否稳定（回调 useCallback、appearanceSettings 是 query data、
 * pluginViews 用 EMPTY_VIEWS）在 App.tsx / plugins/usePluginViewRoute.ts 里逐项核过。
 */
describe("Sidebar memo 包装", () => {
  it("exports Sidebar as a React.memo component", () => {
    const wrapper = Sidebar as unknown as {
      $$typeof?: symbol;
      type?: unknown;
    };

    expect(wrapper.$$typeof).toBe(Symbol.for("react.memo"));
    // 里面必须还是真正的组件实现（不是被替换成空壳）
    expect(typeof wrapper.type).toBe("function");
  });
});
