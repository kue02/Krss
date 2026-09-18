import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { LS_KEYS, readLocalValue } from "./settings-storage";
import {
  DEFAULT_UI_LANG,
  applyUILangFromServer,
  getUILang,
  initializeUILang,
  setUILang,
} from "./ui-lang";

/**
 * 21 批：语言从「只存 localStorage」变成「服务端为准、localStorage 当缓存」。
 * 读写分散在两个组件里（i18n-provider 读、通用设置页写），所以单开一个模块并**导入即注册同步组**。
 */
beforeEach(() => {
  localStorage.clear();
});

describe("ui-lang（21 批）", () => {
  it("没设过 → 固定中文（2026-09-17 已去掉按 navigator.language 自动切换）", () => {
    expect(DEFAULT_UI_LANG).toBe("zh");
    expect(getUILang()).toBe("zh");
  });

  it("老键 gist-lang 的值会被搬过来（用户无感改名）", () => {
    localStorage.setItem("gist-lang", "en");

    expect(getUILang()).toBe("en");
    expect(localStorage.getItem("krss-lang")).toBe("en");
    expect(localStorage.getItem("gist-lang")).toBeNull();
  });

  it("野值（不在 zh/en 里的）一律回落到默认中文", () => {
    localStorage.setItem(LS_KEYS.lang.key, "fr");
    expect(getUILang()).toBe("zh");
  });

  it("setUILang：本地立即生效 + 落新键 + 打同步脏标记（未登录时）", () => {
    setUILang("en");

    expect(getUILang()).toBe("en");
    expect(localStorage.getItem("krss-lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    // 没登录（测试里没有 token）→ 只留脏标记，登录后再推，见 lib/settings-sync.ts
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBe("1");
  });

  it("applyUILangFromServer：只认 zh/en，野值不动本地也不改 <html>", () => {
    setUILang("zh");

    applyUILangFromServer("en");
    expect(getUILang()).toBe("en");

    applyUILangFromServer("de");
    expect(getUILang()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("initializeUILang 把语言落到 <html> 与 i18n 上（i18n-provider 启动时调）", () => {
    localStorage.setItem("krss-lang", "en");
    initializeUILang();

    expect(document.documentElement.lang).toBe("en");
    expect(i18n.language).toBe("en");
  });
});
