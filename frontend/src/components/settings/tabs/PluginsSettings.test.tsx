import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PluginsSettings } from "./PluginsSettings";
import type { PluginMeta } from "@/plugins/types";

const mocks = vi.hoisted(() => ({
  fetchPlugins: vi.fn(),
  setPluginEnabled: vi.fn(),
  rescanPlugins: vi.fn(),
}));

/** 只回 key，不拉 i18n 资源（与同目录既有测试一致） */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/plugins/api", () => ({
  fetchPlugins: mocks.fetchPlugins,
  setPluginEnabled: mocks.setPluginEnabled,
  rescanPlugins: mocks.rescanPlugins,
}));

/**
 * 设置段挂点：这一段用 mock 替掉空注册表，验证「注册了才有、且只在启用时渲染」。
 * 真注册表本期是空的（bark / rsshub 在 Phase B/C 补），空表本身不影响页面。
 */
vi.mock("@/plugins/registry", () => ({
  PLUGIN_SETTINGS_SECTIONS: {
    demo: () => <p>section-for-demo</p>,
  },
}));

function plugin(overrides: Partial<PluginMeta> = {}): PluginMeta {
  return {
    id: "demo",
    name: "Demo 插件",
    description: "演示用的内置插件",
    version: "0.1.0",
    builtin: true,
    transport: "builtin",
    enabled: false,
    actions: [],
    sections: [],
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPlugins.mockResolvedValue([plugin()]);
  mocks.setPluginEnabled.mockImplementation(
    async (id: string, enabled: boolean) => [plugin({ id, enabled })],
  );
});

describe("设置 → 插件（55-8）", () => {
  it("列出插件：名称 + 已停用 + 开关未勾", async () => {
    render(<PluginsSettings />);

    expect(await screen.findByText("Demo 插件")).toBeTruthy();
    expect(screen.getByText("plugins.disabled")).toBeTruthy();
    expect(screen.getByText("plugins.builtin")).toBeTruthy();
    expect(screen.getByText("演示用的内置插件")).toBeTruthy();

    const toggle = screen.getByRole("switch") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("勾开关即落库：以 (id, true) 调 PATCH，随后卡片变「已启用」", async () => {
    render(<PluginsSettings />);
    await screen.findByText("Demo 插件");

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(mocks.setPluginEnabled).toHaveBeenCalledWith("demo", true),
    );
    expect(await screen.findByText("plugins.enabled")).toBeTruthy();
  });

  it("外部插件（transport=http）显示「外部」徽标", async () => {
    mocks.fetchPlugins.mockResolvedValue([
      plugin({
        id: "demo-ext",
        name: "Demo Ext",
        builtin: false,
        transport: "http",
        enabled: true,
      }),
    ]);

    render(<PluginsSettings />);

    expect(await screen.findByText("Demo Ext")).toBeTruthy();
    expect(screen.getByText("plugins.external")).toBeTruthy();
    // 内置徽标不该出现（外部插件的识别就靠这两者的差）
    expect(screen.queryByText("plugins.builtin")).toBeNull();
  });

  it("宿主写了 lastError（崩溃 / 起不来）就红字显示原因", async () => {
    mocks.fetchPlugins.mockResolvedValue([
      plugin({
        id: "demo-ext",
        name: "Demo Ext",
        transport: "http",
        enabled: false,
        lastError: "process exited with code 2",
      }),
    ]);

    render(<PluginsSettings />);

    const reason = await screen.findByText("process exited with code 2");
    expect(reason.className).toContain("text-destructive");
  });

  it("设置段只在「启用了 + 注册了组件」时渲染", async () => {
    mocks.fetchPlugins.mockResolvedValue([plugin({ enabled: false })]);
    render(<PluginsSettings />);
    await screen.findByText("Demo 插件");

    expect(screen.queryByText("section-for-demo")).toBeNull();

    fireEvent.click(screen.getByRole("switch"));

    expect(await screen.findByText("section-for-demo")).toBeTruthy();
  });
});
