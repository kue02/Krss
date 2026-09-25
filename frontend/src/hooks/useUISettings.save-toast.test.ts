import { beforeEach, describe, expect, it, vi } from "vitest";
import { spyOnStorageWrites } from "@/test/storage-write-spy";

/**
 * 28-8（用户 2026-09-25）：「已保存」提示要分级。
 *
 * 用户原话：「有些每一个设置都会弹框告诉我『已保存』……比如切换视图的功能，
 * 还有每一栏调宽度的功能，这些其实都没必要弹框……我每一轻轻调一下，下面就弹个框
 * 告诉我『已保存』，太频繁了。」
 *
 * 判据：**结果肉眼立即可见**的不弹（拖出来的列宽、切过去的档位与样式、拖出来的缩放）；
 * 需要确认自己有没有改成功的（开关、下拉、数值输入）照旧弹。
 *
 * 这里用「每个用例重新 import 模块」的方式，理由同 useUISettings.package.test.ts：
 * 该模块在导入时就同步读 localStorage。
 */
type UISettingsModule = typeof import("./useUISettings");

async function freshModule(): Promise<UISettingsModule> {
  vi.resetModules();
  return await import("./useUISettings");
}

/** 监听「已保存」事件，返回计数读取函数。 */
function countSavedEvents(): () => number {
  let count = 0;
  const onSaved = () => {
    count += 1;
  };
  window.addEventListener("krss:settings-saved", onSaved);
  return () => count;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    value: 1024,
    configurable: true,
  });
  spyOnStorageWrites();
});

describe("28-8 「已保存」提示分级", () => {
  it("结果肉眼立即可见的设置：改完不发「已保存」", async () => {
    const mod = await freshModule();
    const count = countSavedEvents();

    // 拖宽度类
    mod.setUISetting("feedColWidth", 300);
    mod.setUISetting("entryColWidth", 360);
    mod.setUISetting("uiScale", 1.1);
    // 切档位 / 切样式类
    mod.setUISetting("pictureLayout", "hover");
    mod.setUISetting("articleLayout", "hover");
    mod.setUISetting("gridStyle", "square");
    mod.setUISetting("hoverRowHeight", "comfortable");
    mod.setUISetting("hoverImageSize", "large");

    expect(count()).toBe(0);
  });

  it("需要确认的开关 / 下拉 / 数值：照旧各发一次", async () => {
    const mod = await freshModule();
    const count = countSavedEvents();

    mod.setUISetting("cardImageSize", "large");
    expect(count()).toBe(1);

    mod.setUISetting("cardPreviewLines", 3);
    expect(count()).toBe(2);

    mod.setUISetting("sidebarVisible", false);
    expect(count()).toBe(3);
  });

  it("静默不等于不生效：本地与持久化都照常写", async () => {
    const mod = await freshModule();
    const count = countSavedEvents();

    mod.setUISetting("feedColWidth", 333);
    expect(count()).toBe(0);
    // 值确实生效
    expect(mod.getUISettings().feedColWidth).toBe(333);
    // 也确实落进了本地包（供同步推给服务端）
    const pkg = mod.readUISettingsPackage();
    expect(pkg.device.desktop.feedColWidth).toBe(333);
  });

  it("静默键写的是「值」不是「不发事件就不同步」：仍会安排一次同步", async () => {
    const mod = await freshModule();
    const syncSpy = vi.spyOn(
      await import("@/lib/settings-sync"),
      "scheduleSettingsFlush",
    );
    mod.setUISetting("gridStyle", "square");
    expect(syncSpy).toHaveBeenCalledWith("ui");
  });
});
