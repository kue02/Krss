import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreeColumnLayout } from "./three-column-layout";

describe("ThreeColumnLayout", () => {
  it("uses app viewport height instead of 100vh", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("sidebar")).toBeTruthy();
    expect(screen.getByText("list")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();

    const root = container.firstElementChild;
    expect(root?.classList.contains("h-full")).toBe(true);
    expect(root?.classList.contains("h-dvh")).toBe(false);
    expect(root?.classList.contains("h-screen")).toBe(false);
  });
});
