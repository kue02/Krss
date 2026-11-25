import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArticleProse } from "./ArticleProse";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useCodeHighlight", () => ({
  useCodeHighlight: vi.fn(),
}));

vi.mock("@/hooks/useUISettings", () => ({
  useUISettingKey: () => [],
}));

vi.mock("@/components/ui/article-video", () => ({
  ArticleVideo: ({ src }: { src?: string }) => (
    <div data-slot="test-article-video">{src}</div>
  ),
}));

vi.mock("@/components/ui/article-content", () => ({
  ArticleContent: ({ content }: { content?: string }) => <div>{content}</div>,
}));

describe("ArticleProse · 空正文兜底", () => {
  it("entry.url 是直接视频文件时用内置播放器", () => {
    render(<ArticleProse content="" articleUrl="https://cdn.example.com/a/b.mp4" />);
    expect(screen.getByText("https://cdn.example.com/a/b.mp4")).toBeTruthy();
    expect(screen.getByText("https://cdn.example.com/a/b.mp4").dataset.slot).toBe(
      "test-article-video",
    );
  });

  it("普通文章地址仍显示暂无内容", () => {
    render(<ArticleProse content="" articleUrl="https://example.com/post/1" />);
    expect(screen.getByText("entry.no_content")).toBeTruthy();
  });
});
