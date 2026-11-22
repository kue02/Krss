import { describe, expect, it } from "vitest";
import {
  defaultEntryToolbar,
  normalizeEntryToolbar,
  type EntryToolbarItemId,
} from "./entry-toolbar";

describe("normalizeEntryToolbar", () => {
  it("默认全部显示在工具栏", () => {
    expect(defaultEntryToolbar().every((i) => i.placement === "toolbar")).toBe(
      true,
    );
  });

  it("保留三档去向并去重", () => {
    const out = normalizeEntryToolbar([
      { id: "star", placement: "more" },
      { id: "translate", placement: "hidden" },
      { id: "star", placement: "toolbar" },
    ]);
    const byId = Object.fromEntries(
      out.map((i) => [i.id as EntryToolbarItemId, i.placement]),
    );
    expect(byId.star).toBe("more");
    expect(byId.translate).toBe("hidden");
    expect(out.filter((i) => i.id === "star")).toHaveLength(1);
  });

  it("兼容旧数据 hidden 布尔", () => {
    const out = normalizeEntryToolbar([
      { id: "read", hidden: true },
      { id: "readable", hidden: false },
    ]);
    const byId = Object.fromEntries(out.map((i) => [i.id, i.placement]));
    expect(byId.read).toBe("hidden");
    expect(byId.readable).toBe("toolbar");
  });

  it("缺失项补回、脏值回落 toolbar", () => {
    const out = normalizeEntryToolbar([{ id: "star", placement: "bogus" }]);
    expect(out).toHaveLength(7);
    expect(out[0]).toEqual({ id: "star", placement: "toolbar" });
  });
});
