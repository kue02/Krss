import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const applyLang = (lng: string) => {
      document.documentElement.lang = lng === "zh" ? "zh-CN" : "en";
    };

    // 语言只认「设置 → 通用 → 语言」里手动选的那一项（存 localStorage 的 gist-lang）。
    // 2026-09-17 用户明确要求去掉自动切换：不再按 navigator.language 猜，
    // 没设置过就固定用中文（应用主语言）。
    const saved = localStorage.getItem("gist-lang");
    const lang = saved === "zh" || saved === "en" ? saved : "zh";
    i18n.changeLanguage(lang);
    applyLang(lang);

    const onChange = (lng: string) => applyLang(lng);
    i18n.on("languageChanged", onChange);
    return () => {
      i18n.off("languageChanged", onChange);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
