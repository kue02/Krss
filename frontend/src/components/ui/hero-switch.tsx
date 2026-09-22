import type { ReactNode } from "react";
import { Switch } from "@heroui/react";
import { cn } from "@/lib/utils";

interface HeroSwitchProps {
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
  className?: string;
  /** 开关右侧的文字（会一起成为可点区域）。标签另放网格标签列时留空。 */
  children?: ReactNode;
  "aria-label"?: string;
}

/**
 * HeroUI v3 的 `Switch` 是**复合组件**：根部 `SwitchRoot` 只渲染一个空的 `.switch`
 * 容器，轨道（`.switch__control`，40×20）与滑块（`.switch__thumb`）必须由调用方挂上去。
 *
 * 只写 `<Switch isSelected onChange />` 时**量出来是 0 高度、界面上什么都看不见**：
 * 2026-09-18 真机实测 —— 自动化编辑器动作区 5 颗开关（只保留匹配/自动翻译/自动摘要/
 * 推送到手机/Webhook）全是隐形，标签在、开关不在，用户看着就是「动作区没法用」。
 * （jsdom 单测抓不到：样式表不参与，容器照样在 DOM 里。）
 *
 * 所以本项目一律走这里，别在页面里再写裸 `Switch`。
 * 正确形态：`Switch > Switch.Content > (Switch.Control > Switch.Thumb) [+ 文字]`。
 */
export function HeroSwitch({
  isSelected,
  onChange,
  isDisabled,
  className,
  children,
  ...rest
}: HeroSwitchProps) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      // `.switch` 自带 flex-column + align-items:flex-start：放进网格的控件列即左对齐；
      // min-h-8 + justify-center 让「开关行」与旁边 32px 的三态组同高（效果图要求行高统一）
      className={cn("shrink-0 min-h-8 justify-center", className)}
      {...rest}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {children}
      </Switch.Content>
    </Switch>
  );
}
