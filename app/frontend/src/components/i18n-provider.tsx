import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import { initializeUILang } from "@/lib/ui-lang";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const applyLang = (lng: string) => {
      document.documentElement.lang = lng === "zh" ? "zh-CN" : "en";
    };

    // 语言只认「设置 → 通用 → 语言」里手动选的那一项（21 批起：服务端为准、localStorage 当缓存，
    // 见 lib/ui-lang.ts）。2026-09-17 用户明确要求去掉自动切换：不再按 navigator.language 猜，
    // 没设置过就固定用中文（应用主语言）。
    initializeUILang();

    const onChange = (lng: string) => applyLang(lng);
    i18n.on("languageChanged", onChange);
    return () => {
      i18n.off("languageChanged", onChange);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
