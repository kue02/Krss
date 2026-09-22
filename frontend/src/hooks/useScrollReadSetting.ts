import { useCallback, useMemo } from "react";
import type { ContentType } from "@/types/api";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import {
  useUISettingKey,
  type ScrollReadMode,
} from "@/hooks/useUISettings";

/**
 * 「滚动标已读」的唯一解析入口（2026-09-17 收口）。
 *
 * 以前这件事散在三处：后端 `general.mark_read_on_scroll`（通用 tab）、
 * 本地 `scrollReadByView`（外观 → 按视图设置），两边都能改，用户搞不清哪个生效。
 * 现在总开关是三态：
 * - `off`  → 全关，所有视图都不标（各视图的「已读判定」随之失效）；
 * - `on`   → 全开，忽略按视图覆盖；
 * - `perView` → 才允许按视图覆盖（inherit 回落到后端那个布尔值）。
 *
 * 没存过 `scrollReadMode` 的存量数据按现状推导，保证升级后行为不变：
 * 有任一视图不是 `inherit` 就视为 `perView`，否则跟随后端布尔值。
 */
export function useScrollReadSetting() {
  const storedMode = useUISettingKey("scrollReadMode");
  const scrollReadByView = useUISettingKey("scrollReadByView");
  const { data: generalSettings } = useGeneralSettings();
  const globalOn = Boolean(generalSettings?.markReadOnScroll);

  const mode: ScrollReadMode = useMemo(() => {
    if (storedMode === "off" || storedMode === "on" || storedMode === "perView") {
      return storedMode;
    }
    const overrides = Object.values(scrollReadByView ?? {});
    const hasOverride = overrides.some(
      (value) => value && value !== "inherit",
    );
    if (hasOverride) return "perView";
    return globalOn ? "on" : "off";
  }, [storedMode, scrollReadByView, globalOn]);

  const resolveFor = useCallback(
    (contentType: ContentType): boolean => {
      if (mode === "off") return false;
      if (mode === "on") return true;
      const override = scrollReadByView?.[contentType] ?? "inherit";
      if (override === "inherit") return globalOn;
      return override === "on";
    },
    [mode, scrollReadByView, globalOn],
  );

  return { mode, resolveFor, globalOn };
}
