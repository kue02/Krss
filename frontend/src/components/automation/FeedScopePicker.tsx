import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, CheckboxGroup, Popover } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { MarqueeText } from "@/components/ui/marquee-text";

/**
 * 规则/视图的「范围 = 订阅」多选（用户 11-16 要可多选，12-3 改交互）。
 *
 * 用户 12-3 原话：「自动化，范围 feed 那里，弹框打钩，外面不要显示选择了什么，
 * 只显示选择了多少个就行」—— 所以触发器只报个数，勾选在弹框里做。
 *
 * 用 HeroUI 的 `Popover` + `CheckboxGroup`（组件库现成的，不手搓）；
 * 选中的值直接是 feed id 数组，与后端 `scopeIds` 一一对应。
 */
export function FeedScopePicker({
  values,
  onValuesChange,
  options,
  ariaLabel,
}: {
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel?: string;
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
            {values.length === 0
              ? t("automation.scope_all_feeds")
              : t("automation.scope_selected_count", { count: values.length })}
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
              // 不顶掉的话每个选项会「勾选框一行、订阅名一行」，77 个订阅就是 77 组两行（13-2 同一个坑）
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
