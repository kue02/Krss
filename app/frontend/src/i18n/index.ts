import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enTranslations from "../../public/locales/en/common.json";
import zhTranslations from "../../public/locales/zh/common.json";

const resources = {
  en: {
    common: enTranslations,
  },
  zh: {
    common: zhTranslations,
  },
};

/**
 * 首屏语言（22-1）：**初始化时就要用用户选的那份**，不能等 React 的 effect。
 *
 * 老写法是硬写 `lng: "en"`，真正的语言在 `I18nProvider` 的 effect 里才 `changeLanguage()`
 * 切过去（`lib/ui-lang.ts`）。effect 在首屏 paint 之后才跑，于是**每次加载都会先渲染一帧英文**
 * （加载文案是 `entry.loading` = en `Loading...` / zh `加载中…`，实测英文窗口：
 * PWA+SW 热加载 ~20–100ms、dev 未打包 150–350ms；boot guard 触发过自动重载后缓存是最冷的，
 * 窗口最长）。用户看到的「自动刷新后切成英文」就是这一段。
 *
 * 这里直接同步读 localStorage（键名规则与 `lib/settings-storage.ts` 一致：`krss-*` 优先、
 * 老 `gist-*` 兜底），i18next 起来时就是中文。故意**不** import `lib/ui-lang`（它 import 本模块，
 * 会成环）；读键的逻辑就这一处，重复三行换掉一个循环依赖。
 */
const LANG_KEY = "krss-lang";
const LANG_KEY_LEGACY = "gist-lang";
/** 没设过就固定中文（应用主语言，见 `lib/ui-lang.ts` 的说明） */
const DEFAULT_BOOT_LANG = "zh";

function readBootLang(): string {
  try {
    const stored =
      localStorage.getItem(LANG_KEY) ?? localStorage.getItem(LANG_KEY_LEGACY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // 隐私模式 / 存储不可用：按默认语言走
  }
  return DEFAULT_BOOT_LANG;
}

i18n.use(initReactI18next).init({
  resources,
  lng: readBootLang(),
  fallbackLng: "en",
  ns: ["common"],
  defaultNS: "common",
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
