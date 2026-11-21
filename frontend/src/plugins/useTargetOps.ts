import { useMemo } from "react";
import { PLUGIN_TARGETS } from "./targets";
import { useContributions } from "./useContributions";
import type { Surface } from "./surfaces";
import type { PluginContribution } from "./types";

/**
 * 受控 patch（56-16）：把某个挂点上的 `op:"hide"` / `op:"replace"` 贡献项收成两张表，
 * 交给宿主控件自己决定「还画不画 / 换成谁」。
 *
 * 过滤规则全在这一处，控件处只问两句话：
 *   - `isHidden(target)`    → 这个控件该不该消失
 *   - `replacement(target)` → 有没有插件项要顶掉它（没有就是 `undefined`）
 *
 * 只认 `PLUGIN_TARGETS` 里登记过、且对应能力为 `true` 的目标：
 *   - `op:"hide"`    只在 `hideable` 时生效；
 *   - `op:"replace"` 只在 `replaceable` 时生效，同一 target 多条取**第一条**并 warn
 *     （插件作者写重了要知道，但界面不该因此随机换一个）；
 *   - 未登记的 target 一律忽略 —— 宿主不认识的名字，插件写了也改不动东西。
 */
export function useTargetOps(surface: Surface) {
  const items = useContributions(surface);

  const patches = useMemo(() => {
    const hidden = new Set<string>();
    const replacements = new Map<string, PluginContribution>();

    for (const item of items) {
      const target = item.target;
      if (!target) continue;
      const allowed = PLUGIN_TARGETS[target];
      // 未登记 = 宿主没打算让插件改这个控件，静默忽略（不报错：插件可能装在旧版宿主上）
      if (!allowed) continue;

      if (item.op === "hide") {
        if (allowed.hideable) hidden.add(target);
        continue;
      }

      if (item.op === "replace") {
        if (!allowed.replaceable) continue;
        if (replacements.has(target)) {
          console.warn(
            `[plugin] 多条 replace 指向同一控件 ${target}（忽略 ${item.plugin}/${item.id}，用第一条）`,
          );
          continue;
        }
        replacements.set(target, item);
      }
    }

    return { hidden, replacements };
  }, [items]);

  return {
    /** 该控件是否被插件隐藏（只有 hideable 目标生效） */
    isHidden: (target: string) => patches.hidden.has(target),
    /** 替代该控件的插件项（只有 replaceable 目标生效），没有则 undefined */
    replacement: (target: string) => patches.replacements.get(target),
  };
}
