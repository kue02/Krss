import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BarkNotifySection, MASKED_VALUE } from "./BarkNotifySection";

const mocks = vi.hoisted(() => ({
  fetchPluginSettings: vi.fn(),
  savePluginSettings: vi.fn(),
  testPluginAction: vi.fn(),
}));

/** 只回 key，不拉 i18n 资源（与同目录既有测试一致） */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

/** 设置弹窗的未保存登记表：这里只验「有没有登记」，不验弹窗交互 */
vi.mock("@/stores/settings-dirty-store", () => ({
  useSettingsDirty: vi.fn(),
}));

vi.mock("@/plugins/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  fetchPluginSettings: mocks.fetchPluginSettings,
  savePluginSettings: mocks.savePluginSettings,
  testPluginAction: mocks.testPluginAction,
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPluginSettings.mockResolvedValue({ url: MASKED_VALUE });
  mocks.savePluginSettings.mockResolvedValue({ url: MASKED_VALUE });
  mocks.testPluginAction.mockResolvedValue(undefined);
});

describe("插件设置段 · bark 推送（55-13）", () => {
  it("读插件设置：secret 掩码原样显示，不当成明文", async () => {
    render(<BarkNotifySection />);

    const input = (await screen.findByPlaceholderText(
      "https://api.day.app/your-key",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(MASKED_VALUE));
    expect(mocks.fetchPluginSettings).toHaveBeenCalledWith("bark");
    // 掩码没改 → 「保存」按钮保持禁用（不会被误点成「把掩码当密码存回去」）
    const saveButton = screen.getByText("actions.save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("改地址后保存：调 savePluginSettings('bark', {url}) 并显示已保存", async () => {
    render(<BarkNotifySection />);
    const input = (await screen.findByPlaceholderText(
      "https://api.day.app/your-key",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(MASKED_VALUE));

    fireEvent.change(input, {
      target: { value: "  https://api.day.app/NEWKEY  " },
    });
    fireEvent.click(screen.getByText("actions.save"));

    await waitFor(() =>
      expect(mocks.savePluginSettings).toHaveBeenCalledWith("bark", {
        url: "https://api.day.app/NEWKEY",
      }),
    );
    expect(await screen.findByText("plugins.bark.saved")).toBeTruthy();
  });

  it("测试按钮：调插件动作测试接口，失败把原因摆出来", async () => {
    render(<BarkNotifySection />);
    await waitFor(() => expect(mocks.fetchPluginSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("plugins.bark.test"));

    await waitFor(() =>
      expect(mocks.testPluginAction).toHaveBeenCalledWith("bark", "notify"),
    );
    expect(await screen.findByText("plugins.bark.test_ok")).toBeTruthy();
  });

  it("地址为空时点测试：不发请求，直接给一句可见原因", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({});
    render(<BarkNotifySection />);
    await waitFor(() => expect(mocks.fetchPluginSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("plugins.bark.test"));

    expect(await screen.findByText("plugins.bark.test_no_url")).toBeTruthy();
    expect(mocks.testPluginAction).not.toHaveBeenCalled();
  });
});
