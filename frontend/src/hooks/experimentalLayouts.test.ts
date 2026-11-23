import { beforeEach, describe, expect, it, vi } from "vitest";

type UISettingsModule = typeof import("./useUISettings");

async function freshModule(): Promise<UISettingsModule> {
  vi.resetModules();
  return await import("./useUISettings");
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    value: 1024,
    configurable: true,
  });
});

describe("实验布局批：articleLayout 归一与预设", () => {
  it("resolveArticleLayout 把未知/历史值归一到 list，保留 rows/hover", async () => {
    const mod = await freshModule();
    expect(mod.resolveArticleLayout("rows")).toBe("rows");
    expect(mod.resolveArticleLayout("hover")).toBe("hover");
    expect(mod.resolveArticleLayout("list")).toBe("list");
    expect(mod.resolveArticleLayout("masonry")).toBe("list");
    expect(mod.resolveArticleLayout("")).toBe("list");
  });

  it("articleLayoutPreset：rows → bottom + cover；list/hover → right + 不 cover", async () => {
    const mod = await freshModule();
    expect(mod.articleLayoutPreset("rows")).toEqual({
      articlePushDirection: "bottom",
      articleCoverList: true,
    });
    expect(mod.articleLayoutPreset("list")).toEqual({
      articlePushDirection: "right",
      articleCoverList: false,
    });
    expect(mod.articleLayoutPreset("hover")).toEqual({
      articlePushDirection: "right",
      articleCoverList: false,
    });
  });

  it("setArticleLayout 自动套预设：rows 切到从下+覆盖，list/hover 切到从右+不覆盖", async () => {
    const mod = await freshModule();
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => mod.useUISettingActions());

    act(() => result.current.setArticleLayout("rows"));
    expect(mod.getUISettings().articleLayout).toBe("rows");
    expect(mod.getUISettings().articlePushDirection).toBe("bottom");
    expect(mod.getUISettings().articleCoverList).toBe(true);

    // 预设后可手改，手改不应被覆盖（除非再次切换布局）
    act(() => mod.setUISetting("articleCoverList", false));
    expect(mod.getUISettings().articleCoverList).toBe(false);

    act(() => result.current.setArticleLayout("list"));
    expect(mod.getUISettings().articleLayout).toBe("list");
    expect(mod.getUISettings().articlePushDirection).toBe("right");
    expect(mod.getUISettings().articleCoverList).toBe(false);

    act(() => result.current.setArticleLayout("hover"));
    expect(mod.getUISettings().articlePushDirection).toBe("right");
    expect(mod.getUISettings().articleCoverList).toBe(false);
  });
});

describe("实验布局批：门控可见性 resolveExperimentalLayoutVisibility", () => {
  const base = {
    experimentalFeaturesEnabled: false,
    experimentalPictureHover: true,
    experimentalPictureWall: true,
    experimentalArticleHover: true,
  };

  it("总开关关闭时三项全隐藏（即便单项为 true）", async () => {
    const mod = await freshModule();
    expect(mod.resolveExperimentalLayoutVisibility(base)).toEqual({
      pictureHover: false,
      pictureWall: false,
      articleHover: false,
    });
  });

  it("总开关开启时按单项分别可见", async () => {
    const mod = await freshModule();
    expect(
      mod.resolveExperimentalLayoutVisibility({
        ...base,
        experimentalFeaturesEnabled: true,
        experimentalPictureWall: false,
      }),
    ).toEqual({
      pictureHover: true,
      pictureWall: false,
      articleHover: true,
    });
  });

  it("默认设置：总开关与三个单开关全为 false（默认关闭）", async () => {
    const mod = await freshModule();
    expect(mod.defaultUISettings.experimentalFeaturesEnabled).toBe(false);
    expect(mod.defaultUISettings.experimentalPictureHover).toBe(false);
    expect(mod.defaultUISettings.experimentalPictureWall).toBe(false);
    expect(mod.defaultUISettings.experimentalArticleHover).toBe(false);
    expect(mod.defaultUISettings.articlePushDirection).toBe("right");
    expect(mod.defaultUISettings.articleCoverList).toBe(false);
  });
});
