import { PluginFieldControl } from "@/plugins/fields";
import type { PluginField } from "@/plugins/types";

/**
 * 插件动作的动态字段表单（55-14）。
 *
 * 字段形状由插件声明（后端 `plugin.Field` → 前端 `PluginField`），这里只负责把它画出来。
 * 单栏控件的实现在 `@/plugins/fields`（56-9 抽出，插槽表单共用同一份），本组件只做
 * 「一张表单 = 一串控件 + 值容器」这件外壳事：值容器 `config` 是
 * `Record<string, string>`，与后端 `model.PluginActionRef.Config` 逐字一致。
 */
export interface PluginActionFieldsProps {
  fields: PluginField[];
  config?: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** 必填却空着的字段键（保存时校验失败才给，用于红框；平时不传） */
  invalidKeys?: string[];
}

export function PluginActionFields({
  fields,
  config = {},
  onChange,
  invalidKeys = [],
}: PluginActionFieldsProps) {
  return (
    <div className="space-y-2">
      {fields.map((field) => (
        <PluginFieldControl
          key={field.key}
          field={field}
          value={config[field.key] ?? ""}
          onChange={onChange}
          invalid={invalidKeys.includes(field.key)}
        />
      ))}
    </div>
  );
}
