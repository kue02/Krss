import { describe, it, expect, beforeEach } from "vitest";
import type { RefreshFeedResult } from "@/api";
import {
  AUTO_REFRESH_HISTORY_LIMIT,
  appendAutoRefreshHistory,
  clearAutoRefreshHistory,
  groupRefreshFailures,
  loadAutoRefreshHistory,
  sortRefreshSuccesses,
} from "./auto-refresh-history";

const STORAGE_KEY = "krss-auto-refresh-history";

function feed(
  feedId: string,
  title: string,
  extra: Partial<RefreshFeedResult> = {},
): RefreshFeedResult {
  return { feedId, title, new: 0, updated: 0, ...extra };
}

beforeEach(() => {
  localStorage.clear();
});

describe("groupRefreshFailures（19-3 按失败原因分组）", () => {
  it("同一个原因合成一组、组间按条数降序；成功项不进分组", () => {
    const groups = groupRefreshFailures([
      feed("f1", "少数派", { error: "HTTP 502" }),
      feed("f2", "正常源", { updated: 5 }),
      feed("f3", "即刻精选", { error: "HTTP 502" }),
      feed("f4", "歸藏", { error: "timeout（15s）" }),
    ]);

    expect(groups.map((group) => group.reason)).toEqual([
      "HTTP 502",
      "timeout（15s）",
    ]);
    expect(groups[0]?.feeds.map((item) => item.feedId)).toEqual(["f1", "f3"]);
    expect(groups[1]?.feeds).toHaveLength(1);
  });

  it("原因前后的空白不影响归组，空原因被忽略", () => {
    const groups = groupRefreshFailures([
      feed("f1", "A", { error: "  HTTP 502 " }),
      feed("f2", "B", { error: "HTTP 502" }),
      feed("f3", "C", { error: "   " }),
      feed("f4", "D"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.feeds).toHaveLength(2);
  });

  it("没有失败时返回空数组（全成功那行不渲染失败段）", () => {
    expect(groupRefreshFailures([feed("f1", "A", { updated: 3 })])).toEqual([]);
  });
});

describe("sortRefreshSuccesses（成功段按更新条数排序）", () => {
  it("只留成功项，按更新降序、同数按新增降序", () => {
    const sorted = sortRefreshSuccesses([
      feed("f1", "A", { updated: 12, new: 1 }),
      feed("f2", "B", { updated: 0, error: "HTTP 502" }),
      feed("f3", "C", { updated: 120 }),
      feed("f4", "D", { updated: 12, new: 9 }),
    ]);
    expect(sorted.map((item) => item.feedId)).toEqual(["f3", "f4", "f1"]);
  });
});

describe("appendAutoRefreshHistory（19-6 固定最近 20 次、不做可配）", () => {
  it("新的在前，并且硬上限就是 20 条", () => {
    expect(AUTO_REFRESH_HISTORY_LIMIT).toBe(20);
    for (let i = 0; i < 25; i += 1) {
      appendAutoRefreshHistory({
        at: `2026-09-18T09:${String(i).padStart(2, "0")}:00.000Z`,
        newCount: i,
        updatedCount: 0,
        failedCount: 0,
        results: [],
      });
    }
    const records = loadAutoRefreshHistory();
    expect(records).toHaveLength(20);
    // 最新那条在最前（写进去的最后一条是 i=24）
    expect(records[0]?.newCount).toBe(24);
    expect(records.at(-1)?.newCount).toBe(5);
  });

  it("清空后读回空数组", () => {
    appendAutoRefreshHistory({
      at: "2026-09-18T09:00:00.000Z",
      newCount: 1,
      updatedCount: 1,
      failedCount: 0,
      results: [],
    });
    expect(loadAutoRefreshHistory()).toHaveLength(1);
    clearAutoRefreshHistory();
    expect(loadAutoRefreshHistory()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
