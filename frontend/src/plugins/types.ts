/**
 * 插件模块前端契约（与后端 GET /api/plugins 一一对应）。
 *
 * 后端形状见 backend/internal/handler/plugin_handler.go 的 pluginCatalogItem：
 * 清单只管「是什么、开没开、声明了哪些动作与设置段」；设置段的界面是代码、随包发。
 */

/** 插件声明的一个设置字段（渲染成输入框 / 密码框 / 下拉 / 开关） */
export interface PluginField {
  key: string;
  label: string;
  type: "text" | "secret" | "select" | "bool";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

/** 插件贡献给自动化规则的一个动作 */
export interface PluginActionMeta {
  pluginId: string;
  pluginName: string;
  actionId: string;
  label: string;
  fields: PluginField[];
  enabled: boolean;
}

/** 插件往设置弹窗贡献的一段（标题 + 字段） */
export interface PluginSection {
  id: string;
  title: string;
  fields: PluginField[];
}

export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  builtin: boolean;
  /** 55-7b：builtin = 编译进二进制（改代码才需重启）；http = 外部进程（即装即用） */
  transport: "builtin" | "http";
  enabled: boolean;
  /** 崩溃 / 就绪失败时宿主写进来的原因（crashed 状态必带；后端 omitempty，可能是空串） */
  lastError?: string;
  actions: PluginActionMeta[];
  sections: PluginSection[];
}

export interface PluginSettings {
  values: Record<string, string>;
}

/**
 * 给界面的 secret 掩码（8 个 U+2022）。与后端 service.PluginMaskedValue 逐字节一致：
 * 回填这份值 = 「保持原值不变」，所以前端千万别把它当成真密码再存一遍其它字段。
 */
export const PLUGIN_MASKED_VALUE = "••••••••";
