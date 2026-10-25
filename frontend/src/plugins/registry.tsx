import type { ComponentType } from "react";

/**
 * 插件 id → 设置段组件。
 *
 * 设置段是**代码**（随前端包发，放在 plugins/<id>/ 下），不是后端下发的动态表单：
 * 后端只负责说「我有哪些段、每段要有哪些字段、值存成什么样」，长什么样由这里定。
 *
 * 新插件在这里登记一行；没登记但插件已启用时，页面只显示清单卡片、不显示设置段
 * （不会坏，只是这一段还没做）。bark / RSSHub 适配的段落在 Phase B / C 补。
 */
export const PLUGIN_SETTINGS_SECTIONS: Record<string, ComponentType> = {};
