import { ListBox, ListBoxItem, Select as HeroSelect } from "@heroui/react";
import { cn } from "@/lib/utils";

/**
 * 下拉选择器 —— 直接用 HeroUI v3 的 Select（react-aria 引擎）。
 *
 * 为什么不再手搓 <select>：项目铁律是「界面一律走 HeroUI v3 与 Nextflux 既有实现」，
 * 而原生 select 没有样式、没有弹层动效、键盘/触摸行为也不统一。这里只做一层薄包装：
 *   - 值契约保持 string（空串 = 未选择，翻成 null 交给 react-aria 显示 placeholder）
 *   - 选项是 {value, label} 数组，调用方不用关心 ListBoxItem 的 id/key 约定
 * 样式留白：不改 HeroUI 的 token 与动效，只允许调用方补宽度/对齐（className）。
 */
export interface SelectOption {
  value: string;
  label: string;
  /** 选项右侧的次要说明（例如命中数），可选 */
  hint?: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** 无障碍名（下拉本身没有可见 label 时必须给） */
  ariaLabel?: string;
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  ariaLabel,
  className,
}: SelectProps) {
  return (
    <HeroSelect
      aria-label={ariaLabel}
      placeholder={placeholder}
      isDisabled={disabled}
      selectedKey={value === "" ? null : value}
      onSelectionChange={(key) => onChange(key === null ? "" : String(key))}
      className={cn("w-full", className)}
    >
      <HeroSelect.Trigger className="h-8 w-full rounded-md px-2 text-sm">
        <HeroSelect.Value className="truncate" />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBoxItem key={option.value} id={option.value} textValue={option.label}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
