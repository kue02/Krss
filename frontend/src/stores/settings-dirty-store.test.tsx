import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  clearDirtySettings,
  getDirtySettings,
  registerSettingsDirty,
  useDirtySettings,
  useSettingsDirty,
} from "./settings-dirty-store";

/**
 * 消费端探针 —— 这一条是给「白屏」事故守门的：
 * `useSyncExternalStore` 的 getSnapshot 若每次返回新数组，React 会判定快照永远在变 →
 * 无限重渲染 → 整页白屏（第一版就是这么坏的，而只测 store 的命令式 API 查不出来）。
 */
function Probe() {
  const entries = useDirtySettings();
  return <div data-testid="labels">{entries.map((e) => e.label).join(",")}</div>;
}

/**
 * 12-7：表单型设置页的「未保存」登记表。
 * 关键是三条：登记了能查到、注销后查不到、离开时能一次清空（「放弃更改」用）。
 */
describe("设置页未保存登记表", () => {
  beforeEach(() => clearDirtySettings());

  it("登记 / 注销", () => {
    expect(getDirtySettings()).toHaveLength(0);
    registerSettingsDirty("ai", { label: "AI", save: () => {} });
    registerSettingsDirty("network", { label: "网络" });
    expect(getDirtySettings().map((e) => e.label)).toEqual(["AI", "网络"]);

    registerSettingsDirty("network", null);
    expect(getDirtySettings().map((e) => e.label)).toEqual(["AI"]);
  });

  it("navigate 前清空（放弃更改）", () => {
    registerSettingsDirty("ai", { label: "AI" });
    registerSettingsDirty("rsshub", { label: "RSSHub" });
    clearDirtySettings();
    expect(getDirtySettings()).toHaveLength(0);
  });

  it("重复登记同一页不会出现两条", () => {
    registerSettingsDirty("ai", { label: "AI" });
    registerSettingsDirty("ai", { label: "AI" });
    expect(getDirtySettings()).toHaveLength(1);
  });
});

/** 子页探针：模拟「AI 页」真的调 useSettingsDirty（save 每次渲染都是新箭头函数，跟实际一样） */
function DirtyChild({ label }: { label: string }) {
  useSettingsDirty("child", true, label, () => {});
  return <span data-testid="child">{label}</span>;
}

describe("设置页未保存登记表 · 消费端", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    clearDirtySettings();
    errorSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
  });

  it("渲染不炸、快照必须被缓存（防白屏）", () => {
    render(<Probe />);
    expect(screen.getByTestId("labels").textContent).toBe("");

    act(() => registerSettingsDirty("ai", { label: "AI" }));
    expect(screen.getByTestId("labels").textContent).toBe("AI");

    act(() => registerSettingsDirty("rsshub", { label: "RSSHub" }));
    expect(screen.getByTestId("labels").textContent).toBe("AI,RSSHub");

    act(() => registerSettingsDirty("ai", null));
    expect(screen.getByTestId("labels").textContent).toBe("RSSHub");

    // React 的「快照没缓存 → 会无限重渲染」告警一次都不该出现
    const offending = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("getSnapshot"),
    );
    expect(offending).toHaveLength(0);
  });

  it("父消费 + 子登记不会转成无限更新（白屏事故的回归）", () => {
    render(
      <>
        <Probe />
        <DirtyChild label="AI" />
      </>,
    );
    expect(screen.getByTestId("child").textContent).toBe("AI");
    expect(screen.getByTestId("labels").textContent).toBe("AI");
    const loop = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Maximum update depth"),
    );
    expect(loop).toHaveLength(0);
  });
});
