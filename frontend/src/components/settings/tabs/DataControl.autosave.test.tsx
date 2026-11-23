import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataControl } from "./DataControl";

const cacheApi = vi.hoisted(() => ({
  getCacheSettings: vi.fn(),
  updateCacheSettings: vi.fn(),
}));

const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
}));

const cacheData = vi.hoisted(() => ({
  entryRetentionDays: 30,
  tombstoneRetentionDays: 180,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: cacheData }),
  useQueryClient: () => queryClientMock,
}));

vi.mock("@/components/settings/tabs/MCPOutboundSection", () => ({
  MCPOutboundSection: () => null,
}));

vi.mock("@/lib/settings-sync", () => ({
  pullSettingsFromServer: vi.fn(),
}));

vi.mock("@/api", () => ({
  startImportOPML: vi.fn(),
  watchImportStatus: vi.fn(() => vi.fn()),
  cancelImportOPML: vi.fn(),
  exportOPML: vi.fn(),
  exportSettings: vi.fn(),
  importSettings: vi.fn(),
  clearAICache: vi.fn(),
  clearAnubisCookies: vi.fn(),
  clearIconCache: vi.fn(),
  clearReadabilityCache: vi.fn(),
  clearEntryCache: vi.fn(),
  getCacheSettings: cacheApi.getCacheSettings,
  updateCacheSettings: cacheApi.updateCacheSettings,
}));

function entryInput() {
  return screen.getByLabelText(
    "data_control.cache_entry_retention_label",
  ) as HTMLInputElement;
}

describe("DataControl cache auto-save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheApi.updateCacheSettings.mockImplementation(
      async (value: { entryRetentionDays: number; tombstoneRetentionDays: number }) =>
        value,
    );
  });

  it("改动后自动保存，不需要点保存按钮", async () => {
    render(<DataControl />);
    await waitFor(() => expect(entryInput().value).toBe("30"));
    expect(screen.queryByText("data_control.cache_retention_save")).toBeNull();

    fireEvent.change(entryInput(), { target: { value: "31" } });
    await waitFor(
      () =>
        expect(cacheApi.updateCacheSettings).toHaveBeenCalledWith({
          entryRetentionDays: 31,
          tombstoneRetentionDays: 180,
        }),
      { timeout: 1500 },
    );
  });

  it("清空输入框不会被当成 0 自动保存，失焦后恢复原值", async () => {
    render(<DataControl />);
    await waitFor(() => expect(entryInput().value).toBe("30"));

    fireEvent.change(entryInput(), { target: { value: "" } });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(cacheApi.updateCacheSettings).not.toHaveBeenCalled();
    expect(entryInput().value).toBe("");

    fireEvent.blur(entryInput());
    expect(entryInput().value).toBe("30");
  });

  it("防抖窗口内卸载会补发最后一次改动", async () => {
    const view = render(<DataControl />);
    await waitFor(() => expect(entryInput().value).toBe("30"));

    fireEvent.change(entryInput(), { target: { value: "32" } });
    view.unmount();

    await waitFor(() =>
      expect(cacheApi.updateCacheSettings).toHaveBeenCalledWith({
        entryRetentionDays: 32,
        tombstoneRetentionDays: 180,
      }),
    );
    expect(queryClientMock.setQueryData).toHaveBeenCalled();
  });
});
