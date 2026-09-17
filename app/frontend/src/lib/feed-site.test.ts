import { describe, expect, it } from "vitest";
import { resolveFeedSiteUrl } from "./feed-site";

/**
 * 用户第十一批 11-11：右键订阅 →「前往主站 / 复制主站地址」。
 * 主站地址优先取订阅元数据的 site_url，其次从 RSSHub 路由反解；
 * 推不出来要返回 null（调用方藏起菜单项），别硬凑一个看着像主页的地址。
 */
describe("订阅主站地址", () => {
  it("优先用订阅元数据里的 site_url", () => {
    expect(
      resolveFeedSiteUrl({ siteUrl: "https://x.com/op7418", url: "https://rsshub.wxhdj.xyz/twitter/user/op7418?key=x" }),
    ).toBe("https://x.com/op7418");
  });

  it("Telegram 的 site_url 去掉预览路径 /s/", () => {
    expect(resolveFeedSiteUrl({ siteUrl: "https://t.me/s/XiaoZhangDuBao" })).toBe("https://t.me/XiaoZhangDuBao");
  });

  it("没有 site_url 时按 RSSHub 路由反解（用户举的例子）", () => {
    expect(resolveFeedSiteUrl({ url: "https://rsshub.app/twitter/user/elonmusk" })).toBe("https://x.com/elonmusk");
    expect(resolveFeedSiteUrl({ url: "https://rsshub.example.com/telegram/channel/jike_collection?key=abc" })).toBe("https://t.me/jike_collection");
    expect(resolveFeedSiteUrl({ url: "https://rsshub.example.com/bilibili/user/video/2267573" })).toBe("https://space.bilibili.com/2267573");
    expect(resolveFeedSiteUrl({ url: "https://rsshub.example.com/github/repos/DIYgod/RSSHub" })).toBe("https://github.com/DIYgod/RSSHub");
  });

  it("认不出的 RSSHub 路由返回 null（别硬凑）", () => {
    expect(resolveFeedSiteUrl({ url: "https://rsshub.wxhdj.xyz/youzhiyouxing/materials?key=x" })).toBeNull();
    expect(resolveFeedSiteUrl({ url: "https://rsshub.wxhdj.xyz/some/unknown/route" })).toBeNull();
  });

  it("普通订阅没有 site_url 时退回 origin；RSS/XML 文件地址不算主页", () => {
    expect(resolveFeedSiteUrl({ url: "https://blog.example.com/feed" })).toBe("https://blog.example.com");
    expect(resolveFeedSiteUrl({ url: "https://blog.example.com/rss.xml" })).toBeNull();
    expect(resolveFeedSiteUrl({ url: "" })).toBeNull();
    expect(resolveFeedSiteUrl({ url: "not-a-url" })).toBeNull();
  });
});
