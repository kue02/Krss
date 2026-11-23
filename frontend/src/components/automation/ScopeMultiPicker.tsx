import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, CheckboxGroup, Popover } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { MarqueeText } from "@/components/ui/marquee-text";

/**
 * 规则/视图「范围」的多选器（订阅多选 用户 11-16，文件夹也多选 12-x 补）。
 *
 * 触发器只报个数（用户 12-3 原话：「弹框打钩，外面不要显示选择了什么，只显示选择了多少个就行」），
 * 勾选在弹框里做；选中的值直接是 id 数组，与后端 `scopeIds` 一一对应。
 *
 * 订阅与文件夹共用同一套交互，只是空态与计数文案不同，所以做成泛型组件：
 * 由调用方传 `emptyLabel` / `selectedLabel`（作用域不同，文案不同）。
 *
 * 用 HeroUI 的 `Popover` + `CheckboxGroup`（组件库现成的，不手搓）。
 */
export function ScopeMultiPicker({
  values,
  onValuesChange,
  options,
  ariaLabel,
  emptyLabel,
  selectedLabel,
}: {
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel?: string;
  emptyLabel: string;
  selectedLabel: (count: number) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          aria-label={ariaLabel}
          variant="outline"
          size="sm"
          className="w-full justify-between"
        >
          <span className="truncate">
            {values.length === 0 ? emptyLabel : selectedLabel(values.length)}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Content>
        <Popover.Dialog className="w-80 p-2">
          <CheckboxGroup
            aria-label={ariaLabel ?? t("automation.scope")}
            value={values}
            onChange={(next) => onValuesChange(next.map(String))}
            className="max-h-64 overflow-y-auto"
          >
            {options.map((option) => (
              // `flex-row` 不能省：`.checkbox` 组件层写死 flex-direction:column，
              // 不顶掉的话每个选项会「勾选框一行、名字一行」，几十个就是几十组两行（13-2 同一个坑）
              <Checkbox
                key={option.value}
                value={option.value}
                className="flex w-full flex-row items-center gap-2 rounded px-2 py-1 hover:bg-secondary/40"
              >
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Checkbox.Content className="min-w-0 flex-1">
                  <MarqueeText className="text-sm" text={option.label} />
                </Checkbox.Content>
              </Checkbox>
            ))}
          </CheckboxGroup>
        </Popover.Dialog>
      </Popover.Content>
    </Popover.Root>
  );
}
