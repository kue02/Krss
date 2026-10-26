import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { createPluginBridge } from "./bridge";

/**
 * 56-25：宿主侧 bridge v1 的消息处理。
 *
 * 只用 jsdom 的 `MessageEvent` 形状 + 一个假的 `contentWindow`（`postMessage` 是 spy）：
 * 沙箱里的插件是 opaque origin，宿主能拿来定位它的只有 `event.source` 这一个句柄，
 * 所以这里断言的核心就是「谁发的、发给谁、答什么」——不碰真 iframe，也就没有跨源噪声。
 */

const mocks = vi.hoisted(() => ({
  fetchPluginData: vi.fn(),
  putPluginData: vi.fn(),
  listPluginData: vi.fn(),
  deletePluginData: vi.fn(),
  getEntry: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchPluginData: mocks.fetchPluginData,
  putPluginData: mocks.putPluginData,
  listPluginData: mocks.listPluginData,
  deletePluginData: mocks.deletePluginData,
}));

vi.mock("@/api", () => ({
  getEntry: mocks.getEntry,
}));

vi.mock("@/stores/toast-store", () => ({
  showToast: mocks.showToast,
}));

/** 沙箱插件的 contentWindow 替身（跨源，故只有 postMessage 可用） */
function makeFrameWindow() {
  const postMessage = vi.fn();
  const win = { postMessage } as unknown as Window;
  return { win, postMessage };
}

/** 插件发来的一条消息（source = 那个 iframe 的 window） */
function pluginMessage(
  type: string,
  payload: Record<string, unknown>,
  source: unknown,
): MessageEvent {
  return { source, data: { type, payload } } as unknown as MessageEvent;
}

function setup(
  overrides: Partial<Parameters<typeof createPluginBridge>[0]> = {},
) {
  const frame = makeFrameWindow();
  const bridge = createPluginBridge({
    pluginId: "annotate",
    permissions: ["data", "entries:read"],
    frameWindow: () => frame.win,
    locale: "zh",
    ...overrides,
  });
  return { bridge, frame };
}

describe("createPluginBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--foreground");
    document.documentElement.style.removeProperty("--background");
  });

  it("① host:init 带 version=1 / pluginId / permissions / theme（读 <html> 的 CSS 变量）", () => {
    document.documentElement.style.setProperty("--foreground", "#111111");
    document.documentElement.style.setProperty("--background", "#fafafa");
    const { bridge, frame } = setup({
      entry: { id: "2114685590489272320", title: "标题", url: "https://e.x/1" },
    });

    bridge.sendInit();

    expect(frame.postMessage).toHaveBeenCalledTimes(1);
    const [message, targetOrigin] = frame.postMessage.mock.calls[0]!;
    expect(message.type).toBe("host:init");
    expect(message.payload.version).toBe(1);
    expect(message.payload.pluginId).toBe("annotate");
    expect(message.payload.permissions).toEqual(["data", "entries:read"]);
    expect(message.payload.locale).toBe("zh");
    // 主题是可序列化的「变量名 → 值」，插件据此跟宿主同一个配色
    expect(message.payload.theme["--foreground"]).toBe("#111111");
    expect(message.payload.theme["--background"]).toBe("#fafafa");
    // 条目只给身份，正文要插件自己走 bridge 拿
    expect(message.payload.entry).toEqual({
      id: "2114685590489272320",
      title: "标题",
      url: "https://e.x/1",
    });
    // opaque origin 认不出具体源，只能发给「这一个 frame」
    expect(targetOrigin).toBe("*");
  });

  it("② plugin:data.get → 调 /api/plugins/:id/data/... 并回 host:data.result", async () => {
    mocks.fetchPluginData.mockResolvedValue('{"color":"yellow"}');
    const { bridge, frame } = setup();

    bridge.handleMessage(
      pluginMessage(
        "plugin:data.get",
        { id: "req-1", collection: "annotations", key: "2114685590489272320" },
        frame.win,
      ),
    );

    await waitFor(() =>
      expect(frame.postMessage).toHaveBeenCalledWith(
        {
          type: "host:data.result",
          payload: { id: "req-1", value: '{"color":"yellow"}' },
        },
        "*",
      ),
    );
    expect(mocks.fetchPluginData).toHaveBeenCalledWith(
      "annotate",
      "annotations",
      "2114685590489272320",
    );
  });

  it("③ 没有 data 权限 → 回 error，且一次请求都不发", async () => {
    const { bridge, frame } = setup({ permissions: ["entries:read"] });

    bridge.handleMessage(
      pluginMessage("plugin:data.get", { id: "req-2", collection: "annotations", key: "1" }, frame.win),
    );

    await waitFor(() => expect(frame.postMessage).toHaveBeenCalledTimes(1));
    const [message] = frame.postMessage.mock.calls[0]!;
    expect(message.type).toBe("host:data.result");
    expect(message.payload.id).toBe("req-2");
    expect(message.payload.error).toContain("data");
    expect(mocks.fetchPluginData).not.toHaveBeenCalled();
  });

  it("④ event.source 不是这个 iframe → 整条忽略（连回执都不发）", async () => {
    const { bridge, frame } = setup();
    const stranger = makeFrameWindow();

    bridge.handleMessage(
      pluginMessage("plugin:data.get", { id: "req-3", collection: "c", key: "k" }, stranger.win),
    );
    // 冒名顶替的宿主消息（不是 plugin: 前缀）同样不理
    bridge.handleMessage({
      source: frame.win,
      data: { type: "host:init", payload: { pluginId: "evil" } },
    } as unknown as MessageEvent);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(stranger.postMessage).not.toHaveBeenCalled();
    expect(mocks.fetchPluginData).not.toHaveBeenCalled();
  });

  it("⑤ plugin:ui.toast → 调宿主 showToast", () => {
    const { bridge, frame } = setup();

    bridge.handleMessage(
      pluginMessage("plugin:ui.toast", { message: "已高亮", level: "success" }, frame.win),
    );

    expect(mocks.showToast).toHaveBeenCalledWith("已高亮");
  });

  it("⑥ 宿主这边 10s 内没答完 → 回 error=timeout（默认超时可注入以便测试）", async () => {
    mocks.fetchPluginData.mockReturnValue(new Promise(() => {}));
    const { bridge, frame } = setup({ timeoutMs: 10 });

    bridge.handleMessage(
      pluginMessage("plugin:data.get", { id: "req-4", collection: "c", key: "k" }, frame.win),
    );

    await waitFor(
      () =>
        expect(frame.postMessage).toHaveBeenCalledWith(
          { type: "host:data.result", payload: { id: "req-4", error: "timeout" } },
          "*",
        ),
      { timeout: 2000 },
    );
  });
});
