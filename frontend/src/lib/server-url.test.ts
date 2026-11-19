import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("apiUrl", () => {
  it("同源构建保持根相对路径不变", async () => {
    vi.stubEnv("VITE_API_URL", "");
    vi.resetModules();
    const { apiUrl } = await import("./server-url");
    expect(apiUrl("/api/entries")).toBe("/api/entries");
    expect(apiUrl("/icons/feed.png")).toBe("/icons/feed.png");
  });

  it("注入服务器地址后拼到根相对路径前，并忽略末尾斜杠", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090/");
    vi.resetModules();
    const { apiUrl } = await import("./server-url");
    expect(apiUrl("/api/entries")).toBe("http://192.168.1.5:8090/api/entries");
    expect(apiUrl("/icons/feed.png")).toBe("http://192.168.1.5:8090/icons/feed.png");
  });

  it("绝对 URL、data:、blob: 原样返回", async () => {
    vi.stubEnv("VITE_API_URL", "http://192.168.1.5:8090");
    vi.resetModules();
    const { apiUrl } = await import("./server-url");
    expect(apiUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(apiUrl("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(apiUrl("blob:abc")).toBe("blob:abc");
  });
});
