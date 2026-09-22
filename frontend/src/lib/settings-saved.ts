/**
 * 12-7：即时型设置项（开关 / 数量 / 下拉）改一下就落库，用户要一句「已保存」的反馈。
 *
 * 为什么走事件而不是直接在 store 里弹 toast：
 * `useUISettings` 是纯数据层，不该依赖 i18n 与 toast 组件；由 App 订阅事件、拿 t() 文案弹。
 * 另外做了**防抖**：连续拨数字或连点开关只在停手后提示一次，不然会刷屏。
 */
export const SETTINGS_SAVED_EVENT = "krss:settings-saved";

export function notifySettingsSaved(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SETTINGS_SAVED_EVENT));
}

/**
 * 21 批（2026-09-18）：界面设置改完要写服务端（跨设备一致），写失败**必须让用户看见**。
 *
 * 为什么单独一个事件：本地那份（localStorage 缓存）其实已经改好了、界面也已经生效，
 * 只有「推给服务端」这一步失败 —— 不说的话用户会以为一切都保存好了，
 * 换台设备打开才发现少了一半。（用户明确要求：失败须给可见原因，不接受无提示失败。）
 */
export const SETTINGS_SYNC_FAILED_EVENT = "krss:settings-sync-failed";

export function notifySettingsSyncFailed(error?: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SETTINGS_SYNC_FAILED_EVENT, {
      detail: error instanceof Error ? error.message : "",
    }),
  );
}
