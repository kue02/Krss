import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryToc } from "./EntryToc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function makeViewport(html: string) {
  const container = document.createElement("div");
  container.className = "entry-content-viewport";
  container.innerHTML = html;
  container.scrollTo = vi.fn();
  return container;
}

const articleHtml = `
  <article class="entry-content">
    <header><h1>文章大标题</h1></header>
    <div class="ai-summary-content"><h3>AI 摘要</h3></div>
    <div class="prose">
      <h2>第一章</h2>
      <p>正文</p>
      <h3>1.1 小节</h3>
    </div>
  </article>
`;

describe("EntryToc 正文悬浮目录", () => {
  it("没标题时不渲染", async () => {
    const container = makeViewport(`<article class="entry-content"><div class="prose"><p>没有标题</p></div></article>`);
    render(<EntryToc scrollNode={container} entryId="e1" />);

    await waitFor(() => {
      expect(screen.queryByLabelText("entry.toc")).toBeNull();
    });
  });

  it("收集「文章标题 + 正文小标题」，界面自带的块（AI 摘要）不算", async () => {
    const container = makeViewport(articleHtml);
    render(<EntryToc scrollNode={container} entryId="e1" />);

    await waitFor(() => {
      expect(screen.getAllByRole("button")).toHaveLength(3);
    });

    expect(screen.getByText("文章大标题")).toBeTruthy();
    expect(screen.getByText("第一章")).toBeTruthy();
    expect(screen.getByText("1.1 小节")).toBeTruthy();
    expect(screen.queryByText("AI 摘要")).toBeNull();
  });

  it("平时隐藏：面板默认是透明 + 不接收指针事件，hover 才显示", async () => {
    const container = makeViewport(articleHtml);
    render(<EntryToc scrollNode={container} entryId="e1" />);

    const nav = await screen.findByLabelText("entry.toc");
    expect(nav.className).toContain("opacity-0");
    expect(nav.className).toContain("pointer-events-none");
    expect(nav.className).toContain("group-hover/toc:opacity-100");
    expect(nav.className).toContain("group-hover/toc:pointer-events-auto");
  });

  it("点标题会滚动正文容器到该标题", async () => {
    const container = makeViewport(articleHtml);
    render(<EntryToc scrollNode={container} entryId="e1" />);

    const button = await screen.findByText("1.1 小节");
    fireEvent.click(button);

    expect(container.scrollTo).toHaveBeenCalledTimes(1);
    expect(container.scrollTo).toHaveBeenCalledWith({
      top: expect.any(Number),
      behavior: "smooth",
    });
  });

  it("会给标题补 id 与滚动留白，跳转有落点", async () => {
    const container = makeViewport(articleHtml);
    render(<EntryToc scrollNode={container} entryId="e1" />);

    await waitFor(() => {
      expect(container.querySelectorAll(".prose h2[id]").length).toBe(1);
    });

    const heading = container.querySelector<HTMLElement>(".prose h2");
    expect(heading?.id).toBeTruthy();
    expect(heading?.style.scrollMarginTop).toBe("72px");
  });
});
