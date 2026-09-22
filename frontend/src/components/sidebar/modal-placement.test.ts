import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 回归：移动端设置滑不动（2026-09-20 ego 真机实锤）。
 *
 * 根因链：
 * 1. 移动端 Sidebar 装在 Sheet 里，设置弹窗也挂在 Sidebar 树下；
 * 2. 从侧栏点「设置」时 Sheet 还开着，它的 touchmove/wheel 锁
 *   （`ui/sheet.tsx` 的 preventBackgroundScroll）把 Radix Dialog 内容区的
 *    滚动事件在 document 层 preventDefault 吃掉（调用栈实锤：
 *    sheet.tsx:26 + Combination-*.js:956 各吃一次）；
 * 3. 关 Sheet 又会卸载 Sidebar，连带把设置弹窗一起卸载。
 *
 * 修法：设置 / 资料弹窗挂到 App 顶层（与 Sheet 平级），侧栏点开时先关 Sheet。
 * 下面三条断言把这个结构钉死，防止以后有人把弹窗搬回 Sidebar 里。
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", "..", p), "utf-8");

describe("settings/profile modal placement (mobile scroll regression 2026-09-20)", () => {
  it("Sidebar 不再直接挂载 SettingsModal / ProfileModal", () => {
    const sidebar = src("components/sidebar/Sidebar.tsx");
    expect(sidebar).not.toContain("<SettingsModal");
    expect(sidebar).not.toContain("<ProfileModal");
  });

  it("App 顶层挂载 SettingsModal / ProfileModal（与 Sheet 平级）", () => {
    const app = src("App.tsx");
    expect(app).toContain("<SettingsModal open={isSettingsOpen}");
    expect(app).toContain("<ProfileModal open={isProfileOpen}");
  });

  it("侧栏点设置/资料时先关 Sheet（onRequestClose 接 closeSidebar）", () => {
    const sidebar = src("components/sidebar/Sidebar.tsx");
    expect(sidebar).toContain("onRequestClose?.()");
    const app = src("App.tsx");
    expect(app).toContain("onRequestClose={closeSidebar}");
  });

  it("资料弹窗开关走 store（不随 Sidebar 卸载而丢失）", () => {
    const store = src("stores/settings-modal-store.ts");
    expect(store).toContain("useProfileModalStore");
    const sidebar = src("components/sidebar/Sidebar.tsx");
    expect(sidebar).not.toMatch(/useState\(false\).*Profile|isProfileOpen.*useState/);
    expect(sidebar).toContain("useProfileModalStore");
  });

  it("快捷键入口也先关 Sheet（同根漏网，2026-09-20）", () => {
    // 快捷键弹窗从侧栏账户菜单里开：不先关 Sheet，它的滚动锁同样吃掉弹窗滚动。
    const profile = src("components/sidebar/ProfileButton.tsx");
    expect(profile).toContain("onShortcutsClick");
    const bar = src("components/sidebar/SidebarAccountBar.tsx");
    expect(bar).toContain("onShortcutsClick");
    const sidebar = src("components/sidebar/Sidebar.tsx");
    expect(sidebar).toContain("onShortcutsClick");
  });

  it("C-①：子浮层开着时设置切非 modal（Radix 滚动锁让给 HeroUI Drawer）", () => {
    // Radix modal 的滚动锁只认自己 content，规则编辑器 Drawer portal 到 body 会被吃掉滚动；
    // 非 modal 时不挂锁，Drawer.Body 自由滚。Esc/外部点击已有 guard 拦住，不靠 modal。
    const modal = src("components/settings/SettingsModal.tsx");
    expect(modal).toContain("modal={!childOverlayOpen}");
  });

  it("F-1：+号菜单盖过侧栏 Sheet（z-60 > Sheet z-50）", () => {
    // 移动端 Sheet content 是 fixed z-50，菜单 portal 到 body 同 z 下后来居上被盖住。
    const header = src("components/sidebar/SidebarHeader.tsx");
    expect(header).toContain('className="z-[60]"');
  });
});
