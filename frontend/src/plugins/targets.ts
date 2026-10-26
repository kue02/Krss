/**
 * 宿主允许插件「改已有界面」的控件白名单（56-16）。
 *
 * 插件能改什么，是**宿主**说了算：这里没有登记的名字，插件清单里写 `op` + `target`
 * 也一律静默忽略（不报错、不生效）—— 否则插件装进来就能随手藏掉删除按钮、替掉保存。
 *
 * 两种改法的粒度分开登记：
 *   - `hideable`    → `op:"hide"` 时该控件不渲染；
 *   - `replaceable` → `op:"replace"` 时该控件换成插件项（同一 target 多条取第一条）。
 * 两个都 `false` 的登记项是「明确不允许改」的说明性条目（例如删除按钮），留在这里是为了
 * 让「为什么这个控件插件改不动」在代码里有答案，而不是只靠没登记来隐式表达。
 *
 * 新增一个可被插件改的控件 = 在这里登记 + 在控件处调 `useTargetOps`。
 */
export type PluginTarget = { hideable: boolean; replaceable: boolean };

export const PLUGIN_TARGETS: Record<string, PluginTarget> = {
  /** 条目「标为已读 / 标为未读」：可以藏（插件自己接管阅读状态时用），不允许顶掉 */
  "entry.mark_read": { hideable: true, replaceable: false },
  /** 星标：可以藏、也可以换成插件自己的星标（例如同步到稍后读服务） */
  "entry.star": { hideable: true, replaceable: true },
  /** 删除：破坏性操作，插件不许动（登记成 false/false 是为了说明「不是漏登记」） */
  "entry.delete": { hideable: false, replaceable: false },
};
