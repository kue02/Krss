import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SandboxFrame } from "./SandboxFrame";

/**
 * 56-25：沙箱 iframe 本身。
 *
 * bridge 的协议在 `bridge.test.ts` 里逐条测；这里只钉三件「宿主非做不可」的事：
 *   - `sandbox` 只有 `allow-scripts`（多一个 `allow-same-origin` 沙箱就废了）；
 *   - `src` 指向插件自带的 UI 通道，且不吃 referrer；
 *   - onLoad 之后真的发 `host:init`，以及 `plugin:ui.confirm` 能走一趟 HeroUI 弹窗。
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mocks = vi.hoisted(() => ({ getEntry: vi.fn() }));
vi.mock("@/api", () => ({ getEntry: mocks.getEntry, request: vi.fn() }));

/** 一个挂了 spy 的 contentWindow（jsdom 里 iframe 的 window 是真的，改不了 postMessage 的实现，只能 spy） */
function spyOnFrame(frame: HTMLElement): ReturnType<typeof vi.spyOn> {
  const win = (frame as HTMLIFrameElement).contentWindow;
  if (!win) throw new Error("iframe 没有 contentWindow");
  return vi.spyOn(win, "postMessage").mockImplementation(() => undefined);
}

function renderFrame(
  overrides: Partial<React.ComponentProps<typeof SandboxFrame>> = {},
) {
  const utils = render(
    <SandboxFrame
      pluginId="annotate"
      title="标注面板"
      permissions={["data"]}
      locale="zh"
      {...overrides}
    />,
  );
  const frame = utils.container.querySelector("iframe");
  if (!frame) throw new Error("没有渲染 iframe");
  return { ...utils, frame };
}

describe("SandboxFrame", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--foreground");
  });

  it("沙箱属性：只有 allow-scripts（无 allow-same-origin）+ 不带 referrer", () => {
    const { frame } = renderFrame();

    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // 有 allow-same-origin 就等于把插件放进宿主源里（能读 localStorage 的 token）
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("标注面板");
    expect(frame.getAttribute("src")).toBe("/api/plugins/annotate/ui/index.html");
  });

  it("插件 id / 入口里带特殊字符时逐段转义，不把路径拼断", () => {
    const { frame } = renderFrame({ pluginId: "my.plugin", page: "ui/index.html" });

    expect(frame.getAttribute("src")).toBe(
      "/api/plugins/my.plugin/ui/ui/index.html",
    );
  });

  it("onLoad → 给沙箱发 host:init（带主题变量与权限）", () => {
    document.documentElement.style.setProperty("--foreground", "#222222");
    const { frame } = renderFrame({
      permissions: ["data", "entries:read"],
      entry: { id: "2114685590489272320", title: "标题", url: "https://e.x/1" },
    });
    const postMessage = spyOnFrame(frame);

    fireEvent.load(frame);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message, targetOrigin] = postMessage.mock.calls[0];
    expect(message.type).toBe("host:init");
    expect(message.payload.version).toBe(1);
    expect(message.payload.pluginId).toBe("annotate");
    expect(message.payload.permissions).toEqual(["data", "entries:read"]);
    expect(message.payload.theme["--foreground"]).toBe("#222222");
    expect(message.payload.entry).toEqual({
      id: "2114685590489272320",
      title: "标题",
      url: "https://e.x/1",
    });
    expect(targetOrigin).toBe("*");
  });

  it("plugin:ui.confirm → 宿主用 HeroUI 弹窗问，点确认回 confirmed=true", async () => {
    const { frame } = renderFrame();
    const postMessage = spyOnFrame(frame);
    const win = (frame as HTMLIFrameElement).contentWindow as Window;

    window.dispatchEvent(
      new MessageEvent("message", {
        source: win,
        data: {
          type: "plugin:ui.confirm",
          payload: { id: "req-9", title: "删掉这条标注？", body: "删了就没了" },
        },
      }),
    );

    const heading = await screen.findByText("删掉这条标注？");
    expect(heading).toBeTruthy();
    expect(screen.getByText("删了就没了")).toBeTruthy();

    fireEvent.click(screen.getByText("actions.confirm"));

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { type: "host:confirm.result", payload: { id: "req-9", confirmed: true } },
        "*",
      ),
    );
  });
});
