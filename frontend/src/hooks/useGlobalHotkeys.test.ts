import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalHotkeys } from "./useGlobalHotkeys";

function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
}

describe("useGlobalHotkeys", () => {
  let onToggleHelp: Mock<() => void>;
  let onRefresh: Mock<() => void>;

  beforeEach(() => {
    onToggleHelp = vi.fn();
    onRefresh = vi.fn();
  });

  function setup(enabled = true) {
    return renderHook(() => useGlobalHotkeys({ onToggleHelp, onRefresh, enabled }));
  }

  it("? 切换快捷键帮助", () => {
    setup();
    press("?");
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("r 刷新订阅", () => {
    setup();
    press("r");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("焦点在输入框时不抢键", () => {
    setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", bubbles: true }),
    );
    expect(onRefresh).not.toHaveBeenCalled();
    input.remove();
  });

  it("Ctrl/Cmd + R 这类浏览器快捷键放行", () => {
    setup();
    press("r", { metaKey: true });
    press("r", { ctrlKey: true });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("enabled 为 false 时（例如帮助弹窗已打开）不响应", () => {
    setup(false);
    press("?");
    press("r");
    expect(onToggleHelp).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
