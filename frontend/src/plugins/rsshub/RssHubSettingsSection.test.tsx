import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RssHubSettingsSection } from "./RssHubSettingsSection";

const mocks = vi.hoisted(() => ({
  fetchPluginSettings: vi.fn(),
  savePluginSettings: vi.fn(),
}));

/** 只回 key，不拉 i18n 资源（与同目录既有测试一致） */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/plugins/api", () => ({
  fetchPluginSettings: mocks.fetchPluginSettings,
  savePluginSettings: mocks.savePluginSettings,
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [] }),
}));

const basePlaceholder = "https://rsshub.example.com";
const keyPlaceholder = "settings.rsshub_access_key_placeholder";

function inputs() {
  return {
    base: screen.getByPlaceholderText(basePlaceholder) as HTMLInputElement,
    key: screen.getByPlaceholderText(keyPlaceholder) as HTMLInputElement,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

/**
 * 55-18：这一段从「设置 → 通用」搬进插件页，存储从 updateGeneralSettings
 * 换成 savePluginSettings（键 plugin.rsshub.base_url / access_key）。
 */
describe("插件设置段 · RSSHub 实例（55-18）", () => {
  it("读插件设置回填两个输入框（key 是 base_url / access_key）", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({
      base_url: "https://rsshub.mine.dev",
      access_key: "KEY8",
    });

    render(<RssHubSettingsSection />);

    await waitFor(() => expect(inputs().base.value).toBe("https://rsshub.mine.dev"));
    expect(inputs().key.value).toBe("KEY8");
    expect(mocks.fetchPluginSettings).toHaveBeenCalledWith("rsshub");
    // 没改动 → 「保存」保持禁用
    expect((screen.getByText("actions.save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存走插件设置（不再整体 PUT 通用设置）", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({});
    mocks.savePluginSettings.mockResolvedValue({
      base_url: "https://rsshub.mine.dev",
      access_key: "",
    });

    render(<RssHubSettingsSection />);
    await waitFor(() => expect(inputs().base.value).toBe(""));

    fireEvent.change(inputs().base, {
      target: { value: "  https://rsshub.mine.dev  " },
    });
    const save = screen.getByText("actions.save") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.savePluginSettings).toHaveBeenCalledWith("rsshub", {
        base_url: "https://rsshub.mine.dev",
        access_key: "",
      }),
    );
  });
});
