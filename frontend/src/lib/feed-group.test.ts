import { describe, expect, it } from "vitest";
import { MIN_GROUP_SIZE, planDomainGroup } from "./feed-group";
import type { Feed } from "@/types/api";

function feed(
  id: string,
  url: string,
  overrides: Partial<Feed> = {},
): Feed {
  return {
    id,
    title: id,
    url,
    type: "notification",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as Feed;
}

/**
 * 52-5（用户第 5 条）：添加订阅时按**网站域名**自动分组。
 * 关键口径（用户拍板）：域名取反解后的主站（x.com / t.me），
 * 不是 RSSHub 实例 host —— 否则所有源会被塞进同一个实例文件夹。
 */
describe("planDomainGroup", () => {
  const contentType = "notification" as const;

  it("同主站域名的两条散订阅 → 按域名建组（含新加那条）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/telegram/channel/One"),
      feed("b", "https://rsshub.x/telegram/channel/Two"),
    ];
    const plan = planDomainGroup(feeds, "b", contentType);
    expect(plan).not.toBeNull();
    expect(plan?.name).toBe("t.me");
    expect(plan?.feedIds.sort()).toEqual(["a", "b"]);
  });

  it("x.com 与 t.me 不混组（各分各的）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/telegram/channel/One"),
      feed("b", "https://rsshub.x/twitter/user/u1"),
      feed("c", "https://rsshub.x/twitter/user/u2"),
    ];
    const planB = planDomainGroup(feeds, "b", contentType);
    expect(planB?.name).toBe("x.com");
    expect(planB?.feedIds.sort()).toEqual(["b", "c"]);
    // 单独一条 t.me 不足以成组
    expect(planDomainGroup(feeds.slice(0, 1), "a", contentType)).toBeNull();
  });

  it("同域但路径不同也只按域名归（集合类多条源进同一夹）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/github/repos/one/two"),
      feed("b", "https://rsshub.x/github/repos/three/four"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)?.name).toBe("github.com");
  });

  it("普通站点没有 site_url 时用订阅地址本身的主机（不是 RSSHub，是真站）", () => {
    const feeds = [
      feed("a", "https://blog.example.org/feed"),
      feed("b", "https://blog.example.org/atom"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)?.name).toBe("blog.example.org");
  });

  it("普通站点：有 site_url 用主站域名，且去 www", () => {
    const feeds = [
      feed("a", "https://www.appinn.com/feed/", {
        siteUrl: "https://www.appinn.com/",
      }),
      feed("b", "https://appinn.com/other.xml", {
        siteUrl: "https://appinn.com",
      }),
    ];
    expect(planDomainGroup(feeds, "b", contentType)?.name).toBe("appinn.com");
  });

  it("认不出主站的 RSSHub 路由 → 不分組（用户否掉「全塞实例域名一个夹」）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/fancy/route1"),
      feed("b", "https://rsshub.x/fancy/route2"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)).toBeNull();
  });

  // 52-5 真机实测抓到的洞：没带 <link> 的源 site_url 是空的，
  // 又被「.xml 结尾不算主页」判死 ⇒ 两条同域散订阅永远分不到一起。
  // 普通 feed 的地址 host 就是网站域名，该分；RSSHub 仍然不分。
  it("普通 .xml 地址且没有 site_url → 退到订阅地址自己的 host 分组", () => {
    const feeds = [
      feed("a", "http://127.0.0.1:8099/a.xml"),
      feed("b", "http://127.0.0.1:8099/b.xml"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)?.name).toBe("127.0.0.1");
  });

  it("聚合器实例 host（带 rsshub）即便没有可反解的路径也不分组", () => {
    const feeds = [
      feed("a", "https://my.rsshub.host/fancy/route1"),
      feed("b", "https://my.rsshub.host/fancy/route2"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)).toBeNull();
  });

  it("新加那条已在文件夹里 → 不分（用户手选了文件夹，别抢安排）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/telegram/channel/One"),
      feed("b", "https://rsshub.x/telegram/channel/Two", { folderId: "f1" }),
    ];
    expect(planDomainGroup(feeds, "b", contentType)).toBeNull();
  });

  it("同域名但已在别处文件夹的旧订阅不动（只收散着的）", () => {
    const feeds = [
      feed("a", "https://rsshub.x/telegram/channel/One", { folderId: "f1" }),
      feed("b", "https://rsshub.x/telegram/channel/Two"),
    ];
    const plan = planDomainGroup(feeds, "b", contentType);
    // 只剩一条散着 ⇒ 不足 MIN_GROUP_SIZE，不该建组
    expect(plan).toBeNull();
  });

  it("跨视图不混组：文件夹有类型，别的 content type 的散订阅不带上", () => {
    const feeds = [
      feed("a", "https://rsshub.x/telegram/channel/One", { type: "article" }),
      feed("b", "https://rsshub.x/telegram/channel/Two"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)).toBeNull();
  });

  it("不足两条不成组（阈值 = MIN_GROUP_SIZE）", () => {
    expect(MIN_GROUP_SIZE).toBe(2);
    expect(
      planDomainGroup([feed("a", "https://rsshub.x/telegram/channel/One")], "a", contentType),
    ).toBeNull();
  });

  it("推不出域名（非法地址）不成组", () => {
    const feeds = [
      feed("a", "not a url"),
      feed("b", "not a url"),
    ];
    expect(planDomainGroup(feeds, "b", contentType)).toBeNull();
  });
});
