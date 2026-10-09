import { useCallback, useMemo } from "react";
import type { ContentType } from "@/types/api";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import {
  getUISettings,
  setUISetting,
  useUISettingKey,
  type ScrollReadMode,
  type ScrollReadOverride,
  type ViewScrollRead,
} from "@/hooks/useUISettings";

/**
 * 「滚动标已读」的唯一解析入口。
 *
 * 口径变更（2026-10-09 用户拍板「改法 A：不要做这种强制的」）：
 * - **通用那一档只当默认值**：`markReadOnScroll`（后端布尔）= 没有单独设置过的视图的取值。
 * - **按视图覆盖永远优先**：`scrollReadByView[view]` = `inherit`（跟随通用）/ `on` / `off`。
 *   以前 `scrollReadMode` 是「三态强制」——`off`/`on` 会把按视图覆盖整个忽略掉，
 *   于是用户想给「文章视图」单独配一条就得先去通用切成「按视图单独设」，切完又必须
 *   在两个滚动时机里二选一。现在这两道强制都取消了。
 * - `scrollReadMode` 退化成 **UI 形态标记**（还有视图被单独设过 → `perView`），
 *   仍然照写，是为了让旧版本/其它读者读到的语义不变；解析一律走上面的口径。
 *
 * 存量数据行为：以前 `mode=on/off` 时被忽略的按视图覆盖，现在会生效 —— 这正是
 * 用户要的「不要强制」；除此之外（没有覆盖的老数据）行为一字不变。
 */
export function useScrollReadSetting() {
  const scrollReadByView = useUISettingKey("scrollReadByView");
  const scrollReadTimingByView = useUISettingKey("scrollReadTimingByView");
  const { data: generalSettings } = useGeneralSettings();
  const globalOn = Boolean(generalSettings?.markReadOnScroll);

  const hasOverride = (value: ScrollReadOverride | undefined) =>
    value === "on" || value === "off";

  /** 有视图被单独设过 ⇒ 通用那一档就是个「默认值」，不是全局强制 */
  const overrideCount = useMemo(
    () => VIEW_ORDER.filter((view) => hasOverride(scrollReadByView?.[view])).length,
    [scrollReadByView],
  );

  /**
   * UI 形态（旧读者兼容）：有覆盖 → perView；否则跟随后端布尔。
   * 注意这个值**不再参与解析**，只表示「界面上该显示成什么形态」。
   */
  const mode: ScrollReadMode = useMemo(
    () => (overrideCount > 0 ? "perView" : globalOn ? "on" : "off"),
    [overrideCount, globalOn],
  );

  const resolveFor = useCallback(
    (contentType: ContentType): boolean => {
      const override = scrollReadByView?.[contentType];
      if (override === "off") return false;
      if (override === "on") return true;
      return globalOn;
    },
    [scrollReadByView, globalOn],
  );

  /** 按视图那一行的四档取值 */
  const perViewChoice = useCallback(
    (view: ContentType): ScrollReadPerViewChoice => {
      const override = scrollReadByView?.[view];
      if (override === "off") return "clickOnly";
      if (override === "on") {
        return scrollReadTimingByView?.[view] === "onVisible"
          ? "onVisible"
          : "scrollPast";
      }
      return "inherit";
    },
    [scrollReadByView, scrollReadTimingByView],
  );

  /**
   * 写一个视图的四档取值：
   * - 四档映射到「覆盖值 + 时机」两个既有关键字；
   * - 还剩别的视图被单独设过 → `scrollReadMode` 记 `perView`，
   *   一个都没有 → 回到跟随通用的形态（`on` / `off`）。
   *   后端那个布尔**不动**（它是默认值，只有通用那一档才改它）。
   */
  const setPerViewChoice = useCallback(
    (view: ContentType, choice: ScrollReadPerViewChoice) => {
      const next: ScrollReadOverride =
        choice === "inherit" ? "inherit" : choice === "clickOnly" ? "off" : "on";
      const byView: ViewScrollRead = {
        ...getUISettings().scrollReadByView,
        [view]: next,
      };
      setUISetting("scrollReadByView", byView);

      if (choice === "scrollPast" || choice === "onVisible") {
        setUISetting("scrollReadTimingByView", {
          ...getUISettings().scrollReadTimingByView,
          [view]: choice,
        });
      }

      const othersKeepOverride = VIEW_ORDER.some(
        (other) => other !== view && hasOverride(byView[other]),
      );
      setUISetting(
        "scrollReadMode",
        othersKeepOverride ? "perView" : globalOn ? "on" : "off",
      );
    },
    [globalOn],
  );

  /** 还有任何视图会真的滚动标已读吗（通用开着，或有视图被设成 on） */
  const anyViewEnabled = useMemo(
    () =>
      globalOn ||
      VIEW_ORDER.some((view) => scrollReadByView?.[view] === "on"),
    [scrollReadByView, globalOn],
  );

  return {
    mode,
    resolveFor,
    globalOn,
    perViewChoice,
    setPerViewChoice,
    overrideCount,
    anyViewEnabled,
  };
}

const VIEW_ORDER: ContentType[] = ["article", "picture", "notification", "social"];

/** 按视图设置里那一行的四档（改法 A 合并出来的） */
export type ScrollReadPerViewChoice =
  | "inherit"
  | "clickOnly"
  | "scrollPast"
  | "onVisible";
