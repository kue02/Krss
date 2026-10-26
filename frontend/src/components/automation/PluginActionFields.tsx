import { useId } from "react";
import { Checkbox, Input } from "@heroui/react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import type { PluginField } from "@/plugins/types";

/**
 * 插件动作的动态字段表单（55-14）。
 *
 * 字段形状由插件声明（后端 `plugin.Field` → 前端 `PluginField`），这里只负责把它画出来：
 *   - text / secret → HeroUI `Input`（secret 用 `type="password"`，值原样显示，
 *     用户没改就不动它 —— 规则里存的是这条规则自己的地址，不是插件全局设置的掩码）
 *   - bool → HeroUI `Checkbox`（config 里存 "true"/"false" 两个字符串，后端按字符串收）
 *   - select → 仓库既有 `Select` 包装（HeroUI Select + 选项数组）
 *   - required 的字段在标签后加红星；提交时被判定为空的那一栏标红（invalidKeys）
 *
 * 值容器是 `Record<string, string>`，与后端 `model.PluginActionRef.Config` 逐字一致。
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
  // 同一动作里字段键唯一；用 useId 兜住「两个动作都有 url 字段」时的 id 冲突
  const baseId = useId();

  return (
    <div className="space-y-2">
      {fields.map((field) => {
        const value = config[field.key] ?? "";
        const invalid = invalidKeys.includes(field.key);
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
              key={field.key}
              isSelected={value === "true"}
              onChange={(next: boolean) =>
                onChange(field.key, next ? "true" : "false")
              }
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

        const fieldId = `${baseId}-${field.key}`;
        return (
          <div key={field.key} className="space-y-1">
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
      })}
    </div>
  );
}
