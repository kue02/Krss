import { useId } from "react";
import { Checkbox, Input } from "@heroui/react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import type { PluginField } from "./types";

/**
 * 插件声明的一个字段 → 一个控件（56-9）。
 *
 * 这段渲染原来只活在 `components/automation/PluginActionFields.tsx` 里（55-14 的成果），
 * 56-10 的插槽表单要用同一份，所以搬到这里：**设置段的字段表单与插槽里的动作参数表单
 * 共用一套控件**，插件声明的 `fields` 长什么样，两处就长什么样。
 *
 * 各类型怎么画：
 *   - text / secret → HeroUI `Input`（secret 用 `type="password"`，值原样显示，
 *     用户没改就不动它 —— 规则里存的是这条规则自己的地址，不是插件全局设置的掩码）
 *   - bool → HeroUI `Checkbox`（config 里存 "true"/"false" 两个字符串，后端按字符串收）
 *   - select → 仓库既有 `Select` 包装（HeroUI Select + 选项数组）
 *   - required 的字段在标签后加红星；`invalid` 时那一栏标红
 *
 * 值容器是 `Record<string, string>`（一个键一个字符串），与后端
 * `model.PluginActionRef.Config` 逐字一致；本组件只管一栏，容器由调用方管。
 */
export interface PluginFieldControlProps {
  field: PluginField;
  /** 该字段当前的值（容器里取出来的；没有就传空串） */
  value: string;
  onChange: (key: string, value: string) => void;
  /** 必填却空着（保存时校验失败才给，用于红框；平时不传） */
  invalid?: boolean;
}

export function PluginFieldControl({
  field,
  value,
  onChange,
  invalid = false,
}: PluginFieldControlProps) {
  // 每个控件各自 useId：同一张表单里「两个动作都有 url 字段」也不会撞 id
  const fieldId = `${useId()}-${field.key}`;
  const label = (
    <>
      {field.label}
      {field.required && (
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </>
  );

  if (field.type === "bool") {
    return (
      <Checkbox
        isSelected={value === "true"}
        onChange={(next: boolean) => onChange(field.key, next ? "true" : "false")}
        className="flex flex-row items-center gap-2"
      >
        <Checkbox.Control className="shrink-0">
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Checkbox.Content className="min-w-0 text-xs">
          <span className="text-xs text-muted-foreground">{label}</span>
        </Checkbox.Content>
      </Checkbox>
    );
  }

  return (
    <div className="space-y-1">
      <label
        htmlFor={fieldId}
        className="block text-xs text-muted-foreground"
      >
        {label}
      </label>
      {field.type === "select" ? (
        <Select
          ariaLabel={field.label}
          value={value}
          onChange={(next) => onChange(field.key, next)}
          options={field.options ?? []}
          placeholder={field.placeholder}
          className={cn(invalid && "rounded-md ring-2 ring-destructive/40")}
        />
      ) : (
        <Input
          id={fieldId}
          type={field.type === "secret" ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(field.key, event.target.value)}
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          className={cn(
            // text-foreground：抽屉 body 默认 muted，输入值要多一层才够黑
            "h-9 w-full border border-border bg-background text-sm text-foreground",
            invalid && "border-destructive",
          )}
        />
      )}
      {field.help && (
        <p className="text-[11px] text-muted-foreground/70">{field.help}</p>
      )}
    </div>
  );
}
