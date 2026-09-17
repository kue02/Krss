import type { ComponentProps } from "react";
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
  /**
   * 多选模式：给了 selectionMode="multiple" 就改用 values / onValuesChange
   *（HeroUI 的 Select 原生支持多选，这里只是把「Set<string> ↔ string[]」这层转换包进来）。
   * 用途：规则/视图的范围里「订阅」可以多选（用户 11-16）。
   */
  selectionMode?: "single" | "multiple";
  values?: string[];
  onValuesChange?: (values: string[]) => void;
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
  selectionMode = "single",
  values,
  onValuesChange,
}: SelectProps) {
  const multiple = selectionMode === "multiple";
  /**
   * 多选的 props 要显式补一次类型：HeroUI 的 SelectRootProps 只带出了 `selectedKey`，
   * 而它内部直接包的是 react-aria-components 的 Select（运行时支持 `selectionMode` / `selectedKeys`，实测多选可用）。
   */
  const selectionProps = (multiple
    ? { selectionMode: "multiple" as const, selectedKeys: new Set(values ?? []) }
    : {
        selectionMode: "single" as const,
        selectedKey: value === "" ? null : value,
      }) as ComponentProps<typeof HeroSelect>;
  return (
    <HeroSelect
      {...selectionProps}
      aria-label={ariaLabel}
      placeholder={placeholder}
      isDisabled={disabled}
      onSelectionChange={(keys) => {
        // HeroUI 这里沿用了单选 typing（Key | null），多选时运行时给的是 Set —— 按实际形状分派
        const raw: unknown = keys;
        if (multiple) {
          if (raw === "all") {
            onValuesChange?.(options.map((option) => option.value));
            return;
          }
          onValuesChange?.(raw instanceof Set ? [...raw].map(String) : []);
          return;
        }
        const key = raw === "all" ? null : (raw as string | null);
        onChange(key === null ? "" : String(key));
      }}
      className={cn("w-full", className)}
    >
      <HeroSelect.Trigger className="w-full">
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
