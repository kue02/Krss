/**
 * 界面语言（21 批：从「只存 localStorage」变成「服务端为准、localStorage 当缓存」）。
 *
 * 为什么单开一个模块：语言的读写分散在两个组件里（i18n-provider 读、通用设置页写），
 * 而同步组需要在模块导入时就注册好 —— 放在组件里注册会在组件没渲染时不生效。
 */
import i18n from "@/i18n";
import { LS_KEYS, readLocalValue, writeLocalValue } from "@/lib/settings-storage";
import { registerSettingsGroup, scheduleSettingsFlush } from "@/lib/settings-sync";

export type UILang = "zh" | "en";

/** 本地缓存键名（改名清理后只有 `krss-lang`） */
const STORAGE_SPEC = LS_KEYS.lang;

export const DEFAULT_UI_LANG: UILang = "zh";

/**
 * 语言**只认**「设置 → 通用 → 语言」里手动选过的那一项。
 * 2026-09-17 用户明确要求去掉自动切换：不再猜 navigator.language，没设过就固定中文。
 */
export function getUILang(): UILang {
  const stored = readLocalValue(STORAGE_SPEC);
  return stored === "zh" || stored === "en" ? stored : DEFAULT_UI_LANG;
}

function applyLang(lang: UILang): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  void i18n.changeLanguage(lang);
}

/** 用户手动切换语言（设置页用）：本地立即生效 + 防抖写服务端 */
export function setUILang(lang: UILang): void {
  writeLocalValue(STORAGE_SPEC, lang);
  applyLang(lang);
  scheduleSettingsFlush("ui.lang");
}

/** 服务端那份语言覆盖本地（登录后首次拉取时走；不触发反向同步） */
export function applyUILangFromServer(lang: string): void {
  if (lang !== "zh" && lang !== "en") return;

  writeLocalValue(STORAGE_SPEC, lang);
  applyLang(lang);
}

/** 启动时把语言落到 <html> 与 i18n 上（i18n-provider 里调用） */
export function initializeUILang(): void {
  applyLang(getUILang());
}

registerSettingsGroup({
  key: "ui.lang",
  read: () => getUILang(),
  apply: (lang) => applyUILangFromServer(lang),
});
