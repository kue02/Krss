import { useEffect, useState } from "react";

/** 与 SettingsModal / FilterEditorDialog 共用的断点：窄于 768px 即视为移动端 */
const MOBILE_BREAKPOINT = 768;

/**
 * 是否移动端（按窗口宽度判断）。
 *
 * 抽成共享 hook 是因为「同一个组件在移动端换一种外壳」这个模式现在有两处：
 * 设置弹窗（手机全屏 / 桌面居中）与规则编辑器（手机全屏 Sheet / 桌面右侧抽屉）。
 * 两处必须用同一个断点，不然会出现「设置已经全屏了、抽屉还是桌面样式」这种错位。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false,
  );

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return isMobile;
}
