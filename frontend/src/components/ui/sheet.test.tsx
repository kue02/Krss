import { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobileSidebarOpen } from "@/hooks/useMobileLayout";
import { Sheet } from "./sheet";

function dispatchScrollGesture(target: Element, type: "touchmove" | "wheel") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function ControlledSheet({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      {/* 真实应用里侧栏开关是顶栏按钮，和 Sheet 平级 */}
      <button type="button" onClick={() => setOpen(true)}>
        open sidebar
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <button type="button">menu item</button>
      </Sheet>
    </>
  );
}

function getSlots(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>('[data-slot="sheet"]');
  const overlay = container.querySelector<HTMLElement>(
    '[data-slot="sheet-overlay"]',
  );
  const content = container.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (!root || !overlay || !content) {
    throw new Error("Sheet slot elements are missing");
  }
  return { root, overlay, content };
}

function stateOf(element: Element) {
  return element.getAttribute("data-state");
}

function pointer(
  type: "pointerDown" | "pointerMove" | "pointerUp",
  element: Element,
  init: {
    pointerId: number;
    clientX: number;
    clientY: number;
    button?: number;
  },
) {
  fireEvent[type](element, {
    pointerId: init.pointerId,
    pointerType: "touch",
    isPrimary: true,
    button: init.button ?? 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
}

describe("Sheet", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    // 模块级 store 会在用例之间留着，每条用例从「关」开始
    setMobileSidebarOpen(false);
  });

  it("keeps the panel mounted before the first open so opening never mounts it", () => {
    const { container } = render(<ControlledSheet />);
    const { root, content } = getSlots(container);

    // 内容在首次打开之前就已经在 DOM 里（预热挂载），整块停在屏幕外。
    // 关闭态带 aria-hidden/inert，按可访问性查询要显式要求 hidden。
    expect(
      screen.getByRole("button", { name: "menu item", hidden: true }),
    ).toBeTruthy();
    expect(stateOf(root)).toBe("closed");
    expect(stateOf(content)).toBe("closed");
    expect(content.hasAttribute("inert")).toBe(true);
    expect(content.getAttribute("aria-hidden")).toBe("true");
    expect(content.style.transform).toBe("translateX(-100%)");
  });

  it("opens from the trigger with a CSS transition instead of frame-by-frame JS", () => {
    const { container } = render(<ControlledSheet />);
    const { root, content, overlay } = getSlots(container);

    fireEvent.click(screen.getByRole("button", { name: "open sidebar" }));

    expect(stateOf(root)).toBe("open");
    expect(stateOf(content)).toBe("open");
    expect(content.style.transition).toBe(
      "transform 250ms cubic-bezier(0.32, 0.72, 0, 1)",
    );
    // 组件自身不跑 rAF/spring：打开只换 style，动画交给合成层
    expect(content.style.transform).toBe("translateX(0px)");
    expect(overlay.style.transition).toContain("opacity 250ms");
    expect(content.hasAttribute("aria-hidden")).toBe(false);
    expect(content.hasAttribute("inert")).toBe(false);
  });

  it("closes on overlay click and keeps the content mounted", () => {
    const { container } = render(<ControlledSheet initialOpen />);
    const { root, overlay } = getSlots(container);

    expect(stateOf(root)).toBe("open");
    fireEvent.click(overlay);

    expect(stateOf(root)).toBe("closed");
    // 关闭只是切样式，内容不卸载
    expect(screen.getByText("menu item")).toBeTruthy();
  });

  it("closes when Escape is pressed", () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <button type="button">menu item</button>
      </Sheet>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks background scrolling while open and leaves the panel scrollable", () => {
    const { container } = render(<ControlledSheet initialOpen />);
    const { overlay } = getSlots(container);
    const menuItem = screen.getByRole("button", { name: "menu item" });

    expect(document.body.style.overflow).toBe("");
    expect(dispatchScrollGesture(overlay, "touchmove").defaultPrevented).toBe(
      true,
    );
    expect(dispatchScrollGesture(overlay, "wheel").defaultPrevented).toBe(true);
    expect(dispatchScrollGesture(menuItem, "touchmove").defaultPrevented).toBe(
      false,
    );
  });

  it("releases the background scroll lock on close and on unmount", () => {
    const { container, unmount } = render(<ControlledSheet initialOpen />);
    const { root, overlay } = getSlots(container);
    const menuItem = screen.getByRole("button", { name: "menu item" });

    fireEvent.click(overlay);
    expect(stateOf(root)).toBe("closed");
    expect(dispatchScrollGesture(menuItem, "touchmove").defaultPrevented).toBe(
      false,
    );
    expect(
      dispatchScrollGesture(document.body, "touchmove").defaultPrevented,
    ).toBe(false);

    unmount();
    expect(
      dispatchScrollGesture(document.body, "touchmove").defaultPrevented,
    ).toBe(false);
  });

  it("focuses the panel when it opens", () => {
    const { container } = render(<ControlledSheet initialOpen />);
    const { content } = getSlots(container);

    expect(document.activeElement).toBe(content);
  });

  it("closes on a leftward swipe and ignores a vertical gesture", () => {
    const { container } = render(<ControlledSheet initialOpen />);
    const { root, content } = getSlots(container);

    // 竖向滑动交给原生滚动，不应关侧栏
    pointer("pointerDown", content, { pointerId: 2, clientX: 300, clientY: 420 });
    pointer("pointerMove", content, { pointerId: 2, clientX: 296, clientY: 320 });
    pointer("pointerUp", content, { pointerId: 2, clientX: 296, clientY: 320 });
    expect(stateOf(root)).toBe("open");

    // 横向拖动越过起手阈值：面板跟手，松手超过关闭阈值即关闭
    pointer("pointerDown", content, { pointerId: 3, clientX: 300, clientY: 420 });
    pointer("pointerMove", content, { pointerId: 3, clientX: 220, clientY: 424 });
    expect(content.style.transform).toBe("translateX(-80px)");

    pointer("pointerUp", content, { pointerId: 3, clientX: 200, clientY: 424 });
    expect(stateOf(root)).toBe("closed");
  });

  it("follows the mobile sidebar store when uncontrolled", () => {
    const { container } = render(
      <Sheet>
        <button type="button">menu item</button>
      </Sheet>,
    );
    const { root, overlay } = getSlots(container);

    expect(stateOf(root)).toBe("closed");

    act(() => setMobileSidebarOpen(true));
    expect(stateOf(root)).toBe("open");
    expect(screen.getByRole("button", { name: "menu item" })).toBeTruthy();

    // 遮罩关闭要写回 store，而不是只关自己
    fireEvent.click(overlay);
    expect(stateOf(root)).toBe("closed");
  });

  it("does not re-render app-level siblings when the sidebar toggles", () => {
    const siblingRenders = { current: 0 };
    function AppShellSibling() {
      // 每次真正的 render 后 +1（bail out 时不会执行）
      useEffect(() => {
        siblingRenders.current += 1;
      });
      return <div>app content</div>;
    }

    const { container } = render(
      <>
        <AppShellSibling />
        <Sheet>
          <button type="button">menu item</button>
        </Sheet>
      </>,
    );
    const { root } = getSlots(container);
    const rendersBeforeToggle = siblingRenders.current;

    act(() => setMobileSidebarOpen(true));

    // 开关只让订阅者（Sheet）重渲染：App 级兄弟节点一次都不该重渲染
    expect(stateOf(root)).toBe("open");
    expect(siblingRenders.current).toBe(rendersBeforeToggle);

    act(() => setMobileSidebarOpen(false));
    expect(stateOf(root)).toBe("closed");
    expect(siblingRenders.current).toBe(rendersBeforeToggle);
  });

  it("does not re-render the sidebar content when the panel opens", () => {
    const sidebarRenders = { current: 0 };
    function SidebarProbe() {
      useEffect(() => {
        sidebarRenders.current += 1;
      });
      return <button type="button">menu item</button>;
    }

    const { container } = render(
      <Sheet>
        <SidebarProbe />
      </Sheet>,
    );
    const { root } = getSlots(container);
    const rendersBeforeToggle = sidebarRenders.current;

    act(() => setMobileSidebarOpen(true));

    // children 元素对象没变，React 直接跳过 Sidebar 子树：只有面板的 style 变
    expect(stateOf(root)).toBe("open");
    expect(sidebarRenders.current).toBe(rendersBeforeToggle);
  });

  it("still lets props take precedence over the store", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Sheet open={false} onOpenChange={onOpenChange}>
        <button type="button">menu item</button>
      </Sheet>,
    );
    const { root } = getSlots(container);

    act(() => setMobileSidebarOpen(true));
    expect(stateOf(root)).toBe("closed");

    fireEvent.click(container.querySelector('[data-slot="sheet-overlay"]')!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the two mobile call sites independent (no shared state)", () => {
    // App.tsx 有两处 Sheet（插件视图分支 / 主移动布局），分支互斥；
    // 组件本身不能带任何模块级状态，这里用同时挂两个实例来钉住这一点。
    render(
      <>
        <Sheet open onOpenChange={() => {}}>
          <span>sidebar one</span>
        </Sheet>
        <Sheet open={false} onOpenChange={() => {}}>
          <span>sidebar two</span>
        </Sheet>
      </>,
    );

    const sheets = document.querySelectorAll('[data-slot="sheet"]');
    expect(sheets.length).toBe(2);
    expect(stateOf(sheets[0] as Element)).toBe("open");
    expect(stateOf(sheets[1] as Element)).toBe("closed");
    expect(screen.getByText("sidebar one")).toBeTruthy();
    expect(screen.getByText("sidebar two")).toBeTruthy();
  });

  it("snaps back when a short swipe does not cross the dismiss threshold", () => {
    const { container } = render(<ControlledSheet initialOpen />);
    const { root, content } = getSlots(container);

    pointer("pointerDown", content, { pointerId: 4, clientX: 300, clientY: 420 });
    pointer("pointerMove", content, { pointerId: 4, clientX: 270, clientY: 422 });
    pointer("pointerUp", content, { pointerId: 4, clientX: 270, clientY: 422 });

    expect(stateOf(root)).toBe("open");
    expect(content.style.transform).toBe("translateX(0px)");
    expect(content.style.transition).toContain("300ms");
  });
});