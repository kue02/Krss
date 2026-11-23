import type { ReactNode } from "react";
import { Chip, Dropdown, Label } from "@heroui/react";
import { ChevronDown } from "lucide-react";

/**
 * 规则/视图「范围」的多选器（订阅多选 用户 11-16，文件夹也多选 12-x 补）。
 *
 * 12-23 重做：改参考「设置 → 数据控制 → 备份与恢复」那个多选分区的样子 ——
 * 一整行圆角字段：左侧图标块 + 「标题 / 已选摘要」两行 + 右侧数量 Chip 与展开箭头，
 * 点开是带勾选指示的菜单。比原来那颗朴素的 outline 按钮体面，也更贴合设置页的卡片语言。
 *
 * 订阅与文件夹共用同一套交互，只是标题、空态与图标不同，所以做成泛型组件，
 * 由调用方传 `title` / `emptyLabel` / `icon` / `hint`。
 */
export function ScopeMultiPicker({
  values,
  onValuesChange,
  options,
  ariaLabel,
  title,
  emptyLabel,
  icon,
  hint,
}: {
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel?: string;
  /** 字段名（触发器的第一行），如「文件夹」「订阅」 */
  title: string;
  /** 一个都没选时摘要位置显示的文案，如「全部文件夹」 */
  emptyLabel: string;
  /** 左侧图标块里的图标（lucide 元素，size-4） */
  icon?: ReactNode;
  /** 触发器下方的一行小提示 */
  hint?: string;
}) {
  const selectedLabels = options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label);
  // 与「备份分区」一致：摘要直接列出已选的名字（多了就截断）；一个都没选显示空态文案。
  const summary = selectedLabels.length
    ? selectedLabels.join(" · ")
    : values.length > 0
      ? `${values.length}`
      : emptyLabel;

  return (
    <div>
      <Dropdown>
        <Dropdown.Trigger
          aria-label={ariaLabel ?? title}
          className="group flex h-auto w-full items-center justify-between gap-3 rounded-xl border border-border bg-background px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-secondary/50 data-[focus-visible]:ring-2 data-[focus-visible]:ring-primary"
        >
          <span className="flex min-w-0 items-center gap-3">
            {icon ? (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                {icon}
              </span>
            ) : null}
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-foreground">{title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {summary}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Chip
              size="sm"
              variant="tertiary"
              className="border border-border tabular-nums text-muted-foreground"
            >
              {values.length}
            </Chip>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded:rotate-180" />
          </span>
        </Dropdown.Trigger>
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label={ariaLabel ?? title}
            selectionMode="multiple"
            selectedKeys={new Set(values)}
            onSelectionChange={(keys) => {
              const next =
                keys === "all"
                  ? options.map((option) => option.value)
                  : Array.from(keys).map(String);
              onValuesChange(next);
            }}
            className="max-h-72 overflow-y-auto"
          >
            {options.map((option) => (
              <Dropdown.Item
                key={option.value}
                id={option.value}
                textValue={option.label}
              >
                <Label>{option.label}</Label>
                <Dropdown.ItemIndicator className="ms-auto" />
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {hint ? (
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
