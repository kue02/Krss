/**
 * 插件模块前端契约（与后端 GET /api/plugins 一一对应）。
 *
 * 后端形状见 backend/internal/handler/plugin_handler.go 的 pluginCatalogItem：
 * 清单只管「是什么、开没开、声明了哪些动作与设置段」；设置段的界面是代码、随包发。
 */

import type { Surface } from "./surfaces";

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

/*
 * 界面贡献（56-4）。后端形状见 backend/internal/plugin/contribution.go 的 Contribution
 * 与 GET /api/plugins/contributions 的 `{ surfaces: Record<Surface, Contribution[]> }`。
 * 一条 contrib 说的是「哪个挂点上多一个按钮 / 菜单项 / 设置卡片」，点下去调用插件动作。
 */

/** 这条贡献需要什么选中态才可点（none = 随时可点；multi = 至少一条条目/订阅） */
export type PluginSelectionMode = "none" | "single" | "multi";

/** 调用动作时随附的上下文（宿主按 surface 填，插件拿到什么就在什么上做事） */
// 注意：id 一律用字符串。后端 id 是 int64（19 位），走 JS number 会丢精度
// （实测 2114685590489272320 变成 ...300，插件会去操作错条目）。
export type PluginSelection = {
  entryIds?: string[];
  feedIds?: string[];
  filterId?: string;
  viewId?: string;
  textRange?: { start: number; end: number; text: string };
};

/** 插件声明的一条界面贡献（宿主注入 plugin / pluginName，其余来自插件 manifest） */
export type PluginContribution = {
  plugin: string; // 宿主注入：来自哪个插件
  pluginName?: string; // 宿主注入：插件显示名（后端可选回填）
  id: string;
  surface: Surface;
  /** 空 = 追加；hide = 藏掉 target 指的那个宿主元素；replace = 顶掉它 */
  op?: "" | "hide" | "replace";
  target?: string;
  action: string;
  label: string;
  icon?: string;
  group?: string;
  confirm?: string;
  /** 点下去要填的参数（复用设置段那套字段渲染） */
  fields?: PluginField[];
  selection: PluginSelectionMode;
  /** 动作跑完后要失效的前端 caches，例如 ["entries"] */
  refresh?: string[];
};

/** 插件动作的返回：给一句提示 + 要刷新哪些 caches */
export type PluginInvokeResult = {
  message?: string;
  level?: "success" | "error" | "info" | string;
  refresh?: string[];
};

/*
 * 正文装饰（56-22）。后端形状见 `GET /api/entries/:id/decorations` 的
 * `{ decorations: [...] }`：插件在正文上画的一段「行内标记」，例如标注插件高亮的一段原文。
 *
 * `start`/`end` 是**纯文本的 rune 下标**（emoji 算 1 个位置），不是 HTML 字符偏移 ——
 * 前端由 `components/reader/decorations.ts` 落到文本节点上。
 */
export type PluginDecoration = {
  plugin: string;
  id: string;
  start: number;
  end: number;
  /** 语义名，落到 `data-decoration-style`（高亮 / 下划线 / 波浪线由样式表决定） */
  style: string;
  color?: string;
  /** 插件自留的附加信息，原样落到 `data-decoration-data`（JSON） */
  data?: Record<string, string>;
};
