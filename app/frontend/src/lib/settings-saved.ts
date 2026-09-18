/**
 * 12-7：即时型设置项（开关 / 数量 / 下拉）改一下就落库，用户要一句「已保存」的反馈。
 *
 * 为什么走事件而不是直接在 store 里弹 toast：
 * `useUISettings` 是纯数据层，不该依赖 i18n 与 toast 组件；由 App 订阅事件、拿 t() 文案弹。
 * 另外做了**防抖**：连续拨数字或连点开关只在停手后提示一次，不然会刷屏。
 */
export const SETTINGS_SAVED_EVENT = "gist:settings-saved";

export function notifySettingsSaved(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SETTINGS_SAVED_EVENT));
}
