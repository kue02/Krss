import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCacheSettings, updateCacheSettings } from "@/api";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cache settings api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("读取 /api/settings/cache", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ entryRetentionDays: 30, tombstoneRetentionDays: 180 }),
      );

    const result = await getCacheSettings();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/cache",
      expect.anything(),
    );
    expect(result).toEqual({
      entryRetentionDays: 30,
      tombstoneRetentionDays: 180,
    });
  });

  it("保存时显式 0 会原样发给后端（不被当成空值丢掉）", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ entryRetentionDays: 0, tombstoneRetentionDays: 0 }),
      );

    await updateCacheSettings({ entryRetentionDays: 0, tombstoneRetentionDays: 0 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/cache",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          entryRetentionDays: 0,
          tombstoneRetentionDays: 0,
        }),
      }),
    );
  });
});
