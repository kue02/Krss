import { beforeEach, describe, expect, it, vi } from "vitest";

type UISettingsModule = typeof import("./useUISettings");

async function freshModule(): Promise<UISettingsModule> {
  vi.resetModules();
  return await import("./useUISettings");
}

function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1024);
});

describe("文章视图展示方式 articleLayout（reader-transition 批）", () => {
  it("默认 list（= 今天的卡片列表，行为零变化）", async () => {
    const mod = await freshModule();
    expect(mod.defaultUISettings.articleLayout).toBe("list");
    expect(mod.getUISettings().articleLayout).toBe("list");
  });

  it("可在 list / hover 间切换，并落进 shared（跨设备一致）", async () => {
    const mod = await freshModule();
    mod.setUISetting("articleLayout", "hover");
    expect(mod.getUISettings().articleLayout).toBe("hover");

    const raw = JSON.parse(localStorage.getItem("krss-ui-settings") ?? "{}");
    expect(raw.shared?.articleLayout).toBe("hover");

    mod.setUISetting("articleLayout", "list");
    expect(mod.getUISettings().articleLayout).toBe("list");
  });

  it("setArticleLayout action 与直接写键等价", async () => {
    const mod = await freshModule();
    const { renderHook, act } = await import("@testing-library/react");
    const { useUISettingActions } = mod;
    const { result } = renderHook(() => useUISettingActions());
    act(() => {
      result.current.setArticleLayout("hover");
    });
    expect(mod.getUISettings().articleLayout).toBe("hover");
  });
});
