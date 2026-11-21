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
  uninstallPlugin: vi.fn(),
  uploadPlugin: vi.fn(),
}));

/** 只回 key，不拉 i18n 资源（与同目录既有测试一致）；带 params 的键把插值拼进结果 */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const extra = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",");
      return `${key}(${extra})`;
    },
  }),
}));

vi.mock("@/plugins/api", () => ({
  fetchPlugins: mocks.fetchPlugins,
  setPluginEnabled: mocks.setPluginEnabled,
  rescanPlugins: mocks.rescanPlugins,
  uninstallPlugin: mocks.uninstallPlugin,
  uploadPlugin: mocks.uploadPlugin,
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
  mocks.uninstallPlugin.mockResolvedValue([]);
  mocks.uploadPlugin.mockResolvedValue([]);
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

  it("添加插件：选 zip 后调用上传并用返回清单刷新", async () => {
    mocks.uploadPlugin.mockResolvedValue([
      plugin({ id: "pack1", name: "包里的插件", builtin: false, transport: "http" }),
    ]);
    const { container } = render(<PluginsSettings />);
    await screen.findByText("Demo 插件");

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(["zip"], "pack1.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(mocks.uploadPlugin).toHaveBeenCalledWith(file),
    );
    expect(await screen.findByText("包里的插件")).toBeTruthy();
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

  it("内置插件没有「卸载」按钮（内置不能卸载）", async () => {
    mocks.fetchPlugins.mockResolvedValue([
      plugin({ id: "demo", builtin: true, transport: "builtin" }),
    ]);

    render(<PluginsSettings />);
    await screen.findByText("Demo 插件");

    expect(screen.queryByText("plugins.uninstall")).toBeNull();
  });

  it("外部插件：点「卸载」弹二次确认，确认后调 DELETE 一次并用返回清单刷新", async () => {
    mocks.fetchPlugins.mockResolvedValue([
      plugin({
        id: "demo-ext",
        name: "Demo Ext",
        builtin: false,
        transport: "http",
        enabled: true,
      }),
    ]);
    mocks.uninstallPlugin.mockResolvedValue([]);
  mocks.uploadPlugin.mockResolvedValue([]);

    render(<PluginsSettings />);
    await screen.findByText("Demo Ext");

    // 卡片上的「卸载」→ 打开确认弹窗
    fireEvent.click(screen.getByText("plugins.uninstall"));
    expect(
      await screen.findByText("plugins.uninstall_confirm_title"),
    ).toBeTruthy();

    // 确认：DELETE 一次，清单换成空列表，卡片消失
    fireEvent.click(screen.getByText("plugins.uninstall_confirm"));

    await waitFor(() =>
      expect(mocks.uninstallPlugin).toHaveBeenCalledWith("demo-ext"),
    );
    expect(mocks.uninstallPlugin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Demo Ext")).toBeNull());
  });

  it("外部插件：取消确认不调 DELETE", async () => {
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
    await screen.findByText("Demo Ext");

    fireEvent.click(screen.getByText("plugins.uninstall"));
    await screen.findByText("plugins.uninstall_confirm_title");

    fireEvent.click(screen.getByText("actions.cancel"));

    await waitFor(() =>
      expect(screen.queryByText("plugins.uninstall_confirm_title")).toBeNull(),
    );
    expect(mocks.uninstallPlugin).not.toHaveBeenCalled();
    // 卡片还在
    expect(screen.getByText("Demo Ext")).toBeTruthy();
  });
});
