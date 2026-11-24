import { beforeEach, describe, expect, it, vi } from "vitest";

type UISettingsModule = typeof import("./useUISettings");

async function freshModule(): Promise<UISettingsModule> {
  vi.resetModules();
  return await import("./useUISettings");
}

function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

function storedPackage(): {
  shared?: Record<string, unknown>;
  device?: { desktop?: Record<string, unknown>; mobile?: Record<string, unknown> };
} {
  return JSON.parse(localStorage.getItem("krss-ui-settings") ?? "{}");
}

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1024);
});

describe("双栏分界限自动隐藏 splitterAutoHide（11-24 用户第 3 条）", () => {
  it("默认关 = 平时也画这条线（行为零变化），且写进 shared 档", async () => {
    const mod = await freshModule();
    expect(mod.defaultUISettings.splitterAutoHide).toBe(false);
    expect(mod.getUISettings().splitterAutoHide).toBe(false);

    mod.setUISetting("splitterAutoHide", true);
    expect(mod.getUISettings().splitterAutoHide).toBe(true);
    expect(storedPackage().shared?.splitterAutoHide).toBe(true);
    // 非设备级键不该落进 device 段（否则 device 会覆盖 shared）
    expect(storedPackage().device?.desktop?.splitterAutoHide).toBeUndefined();
    expect(storedPackage().device?.mobile?.splitterAutoHide).toBeUndefined();
  });

  it("与「按视图显示分界限」正交：开自动隐藏不影响 splitterVisibleByView", async () => {
    const mod = await freshModule();
    const before = mod.getUISettings().splitterVisibleByView;
    mod.setUISetting("splitterAutoHide", true);
    expect(mod.getUISettings().splitterVisibleByView).toEqual(before);
  });
});

describe("提示里点「文章也关闭」后的自动恢复（11-24）", () => {
  async function actions() {
    const mod = await freshModule();
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => mod.useUISettingActions());
    return { mod, result };
  }

  it("标记默认 false，且写进 shared 档", async () => {
    const mod = await freshModule();
    expect(mod.defaultUISettings.inoreaderSplitterAutoOff).toBe(false);
  });

  it("hideArticleSplitterFromPrompt：关掉文章分界限并记下「提示替关」", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.hideArticleSplitterFromPrompt();
    });
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(false);
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(true);
    // 其它视图不动
    expect(mod.getUISettings().splitterVisibleByView.picture).toBe(false);
  });

  it("从 Inoreader 列表切回别的布局 → 自动恢复文章分界限，并清掉标记", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.setArticleLayout("inoreader");
      result.current.hideArticleSplitterFromPrompt();
    });
    act(() => {
      result.current.setArticleLayout("list");
    });
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(true);
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(false);
    expect(storedPackage().shared?.splitterVisibleByView).toEqual({
      article: true,
      picture: false,
      notification: false,
      social: false,
    });
  });

  it("防误伤①：用户手动关掉文章分界限（没点提示按钮）→ 切走布局不自动打开", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.setArticleLayout("inoreader");
      result.current.setSplitterVisibleForView("article", false);
    });
    act(() => {
      result.current.setArticleLayout("list");
    });
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(false);
  });

  it("防误伤②：点了提示按钮之后用户又手动改过 → 标记清掉，切走不再自动打开", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.setArticleLayout("inoreader");
      result.current.hideArticleSplitterFromPrompt();
    });
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(true);
    act(() => {
      // 真的改了（把文章这条线打开）才算「用户自己动过」
      result.current.setSplitterVisibleForView("article", true);
    });
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(false);
    act(() => {
      result.current.setArticleLayout("list");
    });
    // 用户自己开的，切走也不会被改回关
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(true);
  });

  it("防误伤③：点回当前已选中的那一档不算改过 → 标记保留，切走仍自动恢复", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.setArticleLayout("inoreader");
      result.current.hideArticleSplitterFromPrompt();
    });
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(true);
    act(() => {
      // 当前已经是「关」，再点一次「关」——用户没改动任何设置
      result.current.setSplitterVisibleForView("article", false);
    });
    expect(mod.getUISettings().inoreaderSplitterAutoOff).toBe(true);
    act(() => {
      result.current.setArticleLayout("list");
    });
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(true);
  });

  it("只恢复 article：图片/社交媒体/通知视图的关闭状态保持不动", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.setArticleLayout("inoreader");
      result.current.hideArticleSplitterFromPrompt();
    });
    act(() => {
      result.current.setArticleLayout("rows");
    });
    expect(mod.getUISettings().splitterVisibleByView).toEqual({
      article: true,
      picture: false,
      notification: false,
      social: false,
    });
  });

  it("不是从 Inoreader 切走（例如 list → rows）不触发恢复", async () => {
    const { mod, result } = await actions();
    const { act } = await import("@testing-library/react");
    act(() => {
      result.current.hideArticleSplitterFromPrompt();
    });
    act(() => {
      result.current.setArticleLayout("rows");
    });
    expect(mod.getUISettings().splitterVisibleByView.article).toBe(false);
  });
});
