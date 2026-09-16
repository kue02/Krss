import { describe, expect, it } from "vitest";
import { isRssHubUrl, rewriteRssHubUrl } from "@/lib/rsshub";

describe("isRssHubUrl", () => {
  it("认得公共实例与自建实例", () => {
    expect(isRssHubUrl("https://rsshub.app/twitter/user/op7418")).toBe(true);
    expect(isRssHubUrl("https://rsshub.wxhdj.xyz/twitter/user/op7418")).toBe(true);
  });

  it("普通源不算 RSSHub", () => {
    expect(isRssHubUrl("https://sspai.com/feed")).toBe(false);
    expect(isRssHubUrl("not a url")).toBe(false);
    expect(isRssHubUrl("ftp://rsshub.app/x")).toBe(false);
  });

  it("可把别的实例域名显式算作 RSSHub", () => {
    expect(isRssHubUrl("https://my-instance.dev/a/b")).toBe(false);
    expect(isRssHubUrl("https://my-instance.dev/a/b", ["https://my-instance.dev"])).toBe(true);
  });
});

describe("rewriteRssHubUrl", () => {
  it("换域名并保留路由", () => {
    expect(
      rewriteRssHubUrl(
        "https://rsshub.app/twitter/user/op7418",
        "https://rsshub.wxhdj.xyz",
      ),
    ).toBe("https://rsshub.wxhdj.xyz/twitter/user/op7418");
  });

  it("保留查询参数并写入 ACCESS_KEY", () => {
    expect(
      rewriteRssHubUrl(
        "https://rsshub.app/twitter/user/op7418?limit=20",
        "https://rsshub.wxhdj.xyz",
        "abc123",
      ),
    ).toBe("https://rsshub.wxhdj.xyz/twitter/user/op7418?limit=20&key=abc123");
  });

  it("已有 key 参数时覆盖", () => {
    expect(
      rewriteRssHubUrl(
        "https://rsshub.app/x/y?key=old",
        "https://rsshub.wxhdj.xyz",
        "new",
      ),
    ).toBe("https://rsshub.wxhdj.xyz/x/y?key=new");
  });

  it("没配 ACCESS_KEY 时清掉旧的 key", () => {
    expect(
      rewriteRssHubUrl("https://rsshub.app/x/y?key=old", "https://rsshub.wxhdj.xyz", ""),
    ).toBe("https://rsshub.wxhdj.xyz/x/y");
  });

  it("目标实例带路径前缀时拼在前面", () => {
    expect(
      rewriteRssHubUrl("https://rsshub.app/a/b", "https://example.com/rsshub/"),
    ).toBe("https://example.com/rsshub/a/b");
  });

  it("非 RSSHub 地址或坏地址返回 null", () => {
    expect(rewriteRssHubUrl("https://sspai.com/feed", "https://rsshub.wxhdj.xyz")).toBeNull();
    expect(rewriteRssHubUrl("https://rsshub.app/a", "oops")).toBeNull();
  });
});
