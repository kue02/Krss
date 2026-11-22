import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MachineTranslatedBadge } from "./machine-translated-badge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 只关心 key 是否被选中；真实中文文案由 locales 保证
    t: (key: string) => key,
  }),
}));

function renderBadge(children: ReactNode) {
  return render(<TooltipProvider>{children}</TooltipProvider>);
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function getBadge(container: HTMLElement): HTMLElement {
  const badge = container.querySelector<HTMLElement>(
    "[data-machine-translated]",
  );
  if (!badge) throw new Error("badge not found");
  return badge;
}

describe("MachineTranslatedBadge 完成态文案", () => {
  beforeEach(() => setViewportWidth(1024));
  afterEach(() => setViewportWidth(1024));

  it("免费通道只显示 provider，不出现「Google 翻译」这类 label", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge
        provider="Google"
        service="Google 翻译"
        model=""
      />,
    );

    expect(getBadge(container).getAttribute("aria-label")).toBe("Google");
  });

  it("走模型时显示 provider · model", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge
        provider="OpenAI"
        model="gpt-4o-mini"
        service="gpt-4o-mini"
      />,
    );

    expect(getBadge(container).getAttribute("aria-label")).toBe(
      "OpenAI · gpt-4o-mini",
    );
  });

  it("缺 provider 时只显示 model", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge model="gpt-4o-mini" />,
    );

    expect(getBadge(container).getAttribute("aria-label")).toBe("gpt-4o-mini");
  });

  it("只有 service 时只显示 service", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge service="Google 翻译" />,
    );

    expect(getBadge(container).getAttribute("aria-label")).toBe("Google 翻译");
  });

  it("老数据三字段全缺时退回原 label，不留空", () => {
    const { container } = renderBadge(<MachineTranslatedBadge />);

    expect(getBadge(container).getAttribute("aria-label")).toBe(
      "entry.machine_translated",
    );
  });

  it("摘要完成态同样使用 provider · model", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge
        variant="summary"
        provider="OpenAI"
        model="gpt-4o-mini"
      />,
    );

    expect(getBadge(container).getAttribute("aria-label")).toBe(
      "OpenAI · gpt-4o-mini",
    );
  });

  it("失败态优先显示后端错误，并保留红色状态", () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge state="failed" error="HTTP 429" />,
    );
    const badge = getBadge(container);

    expect(badge.getAttribute("data-translation-state")).toBe("failed");
    expect(badge.getAttribute("aria-label")).toBe("HTTP 429");
    expect(badge.className).toContain("text-destructive");
  });
});

describe("MachineTranslatedBadge 移动端点击说明", () => {
  beforeEach(() => setViewportWidth(390));
  afterEach(() => setViewportWidth(1024));

  it("点徽标就地弹出说明，且不冒泡到卡片点击/长按", async () => {
    const cardClick = vi.fn();
    const cardTouchStart = vi.fn();
    const { container } = renderBadge(
      <div onClick={cardClick} onTouchStart={cardTouchStart}>
        <MachineTranslatedBadge provider="Google" service="Google 翻译" />
      </div>,
    );

    const badge = getBadge(container);
    expect(badge.getAttribute("role")).toBe("button");
    expect(badge.getAttribute("aria-label")).toBe("Google");

    fireEvent.click(badge);

    await waitFor(() => {
      expect(screen.getByText("Google")).toBeTruthy();
    });
    expect(cardClick).not.toHaveBeenCalled();

    // 再点一次收起
    fireEvent.click(badge);
    await waitFor(() => {
      expect(screen.queryByText("Google")).toBeNull();
    });

    // 长按由 touchstart 起手：这一下也不能让卡片的长按菜单起来
    fireEvent.touchStart(badge);
    expect(cardTouchStart).not.toHaveBeenCalled();
  });

  it("打开后点空白处也会收起", async () => {
    const { container } = renderBadge(
      <MachineTranslatedBadge provider="Google" />,
    );
    const badge = getBadge(container);

    fireEvent.click(badge);
    await waitFor(() => expect(screen.getByText("Google")).toBeTruthy());

    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body, { button: 0 });
    await waitFor(() => expect(screen.queryByText("Google")).toBeNull());
  });

  it("40px 热区靠伪元素实现，不增加行高", () => {
    const { container } = renderBadge(<MachineTranslatedBadge provider="Google" />);
    const badge = getBadge(container);

    expect(badge.className).toContain("before:-left-[13px]");
    expect(badge.className).toContain("before:-right-[13px]");
    expect(badge.className).toContain("before:-top-[18px]");
    expect(badge.className).toContain("before:-bottom-[8px]");
  });

  it("桌面宽度仍走 hover Tooltip 的 img 语义，不挂 Popover trigger", () => {
    setViewportWidth(1024);
    const { container } = renderBadge(<MachineTranslatedBadge provider="Google" />);
    const badge = getBadge(container);

    expect(badge.getAttribute("role")).toBe("img");
    expect(badge.getAttribute("data-slot")).toBeNull();
  });
});
