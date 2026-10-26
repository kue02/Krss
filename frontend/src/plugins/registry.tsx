import type { ComponentType } from "react";
import { BarkNotifySection } from "./bark/BarkNotifySection";
import { RssHubSettingsSection } from "./rsshub/RssHubSettingsSection";

/**
 * 插件 id → 设置段组件。
 *
 * 设置段是**代码**（随前端包发，放在 plugins/<id>/ 下），不是后端下发的动态表单：
 * 后端只负责说「我有哪些段、每段要有哪些字段、值存成什么样」，长什么样由这里定。
 *
 * 新插件在这里登记一行；没登记但插件已启用时，页面只显示清单卡片、不显示设置段
 * （不会坏，只是这一段还没做）。
 */
export const PLUGIN_SETTINGS_SECTIONS: Record<string, ComponentType> = {
  // 55-13：Bark 推送地址从「设置 → 通用」搬到这里（键 plugin.bark.url）
  bark: BarkNotifySection,
  // 55-18：RSSHub 实例地址从「设置 → 通用」搬到这里（键 plugin.rsshub.base_url / access_key）
  rsshub: RssHubSettingsSection,
};
