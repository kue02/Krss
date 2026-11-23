import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { useVideoPreviewStore } from "@/stores/video-preview-store";
import { VideoPreview } from "./video-preview";

// 测试环境不初始化 i18n：t() 回显 key
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 直接渲染 dialog 子节点，避免 radix Portal / 焦点管理干扰
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

// 同源直传：不发起鉴权请求
vi.mock("@/lib/use-authed-image", () => ({
  useAuthedImageUrl: (src?: string) => src,
}));

describe("VideoPreview", () => {
  beforeEach(() => {
    useVideoPreviewStore.getState().close();
    // jsdom 未实现媒体播放/暂停，避免 "Not implemented" 错误
    window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    window.HTMLMediaElement.prototype.pause = vi.fn();
  });

  it("渲染带 controls / playsInline 的视频播放器", () => {
    useVideoPreviewStore.getState().open("https://example.com/v.mp4", null);

    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.getAttribute("src")).toBe("https://example.com/v.mp4");
  });

  it("点击全屏按钮对 video 调用 requestFullscreen", () => {
    useVideoPreviewStore.getState().open("https://example.com/v.mp4", null);
    const { container } = render(<VideoPreview />);

    const video = container.querySelector("video")!;
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(video, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });

    const button = screen.getByRole("button", {
      name: "entry.video_fullscreen",
    });
    fireEvent.click(button);

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("点击关闭按钮关闭播放器", () => {
    useVideoPreviewStore.getState().open("https://example.com/v.mp4", null);
    render(<VideoPreview />);

    const closeButton = screen.getByRole("button", {
      name: "entry.video_close",
    });
    fireEvent.click(closeButton);

    expect(useVideoPreviewStore.getState().isOpen).toBe(false);
  });

  it("进入全屏后图标/aria 切换为退出，点击调用 exitFullscreen", async () => {
    useVideoPreviewStore.getState().open("https://example.com/v.mp4", null);
    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video")!;

    const exitFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video,
    });

    await act(async () => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    const exitButton = screen.getByRole("button", {
      name: "entry.video_exit_fullscreen",
    });
    fireEvent.click(exitButton);

    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
