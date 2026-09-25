import { beforeEach, describe, expect, it, vi } from "vitest";
import { spyOnStorageWrites } from "@/test/storage-write-spy";

/**
 * 28-9：本机改一个键 → 防抖 flush → 真正 PUT 出去的 body 里带上了这个新值。
 *
 * **这条锁的是「接线」，不是「不覆盖对方」**：`initSettingsSync` 会把服务端那份拉成本地副本，
 * 单进程里造不出「本机缓存陈旧、服务端已被另一台改过」的局面，所以"只盖本机动过的键"这个
 * 语义由 `settings-sync.test.ts` 里 `mergeUiPackage` 的两条直接锁（那两条能精确构造两份不同的包）。
 *
 * 这里守的是另一头：链路上任何一环漏接（比如 `setUISetting` 忘了调 `markUiSettingsChanged`），
 * `changedKeys` 就会是空的，本机新改的值推不上去 —— 那时下面的断言会挂。
 *   setUISetting → markUiSettingsChanged → flushSettings → takeChangedUiKeys
 *                → buildSettingsPayload → mergeUiPackage
 */
type UISettingsModule = typeof import("@/hooks/useUISettings");
type SyncModule = typeof import("@/lib/settings-sync");

vi.mock("@/api", () => ({
  getAuthToken: vi.fn(() => "test-token"),
  getUISettings: vi.fn(),
  putUISettings: vi.fn(async () => ({ ok: true })),
}));

async function freshModules(): Promise<[UISettingsModule, SyncModule]> {
  vi.resetModules();
  const ui = await import("@/hooks/useUISettings");
  const sync = await import("@/lib/settings-sync");
  return [ui, sync];
}

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  spyOnStorageWrites();
  const sync = await import("@/lib/settings-sync");
  sync.resetSettingsSyncForTests();
});

describe("28-9 推送时只盖本机动过的键（端到端接线）", () => {
  it("本机改了 gridStyle → PUT 出去的 body 里带上了新值（接线完整）", async () => {
    const [ui, sync] = await freshModules();
    const api = await import("@/api");

    // 服务端那份：cardPreviewLines=9 是「另一台设备」改的，本机并不知情
    vi.mocked(api.getUISettings).mockResolvedValue({
      empty: false,
      ui: {
        shared: { cardPreviewLines: 9, gridStyle: "square" },
        device: { desktop: {}, mobile: {} },
      },
      theme: { mode: "dark" },
      lang: "zh",
      sidebarState: {},
    } as never);

    sync.registerSettingsGroup({
      key: "ui",
      read: () => ui.readUISettingsPackage(),
      apply: () => {},
    });
    sync.registerSettingsGroup({ key: "ui.lang", read: () => "zh", apply: () => {} });

    // 先按正常启动流程把服务端那份拉进来（本机缓存此时是 cardPreviewLines=9）
    await sync.initSettingsSync();

    // 本机改了 gridStyle（唯一动过的键）
    ui.setUISetting("gridStyle", "masonry");

    await sync.flushSettingsNow();

    const payload = vi.mocked(api.putUISettings).mock.calls.at(-1)?.[0] as {
      ui?: { shared?: Record<string, unknown> };
    };
    expect(payload?.ui?.shared?.gridStyle).toBe("masonry");
    // 本机那份的 cardPreviewLines 与服务端一致（都是 9），这里只是确认它没被写坏
    expect(payload?.ui?.shared?.cardPreviewLines).toBe(9);
  });
});
