import { describe, expect, it } from "vitest";
import { parseSocialSource } from "@/lib/social-source";

describe("parseSocialSource", () => {
  it("识别 X / Twitter 链接", () => {
    expect(parseSocialSource("https://x.com/op7418/status/2100033975758856654")).toEqual({
      platform: "x",
      handle: "op7418",
      profileUrl: "https://x.com/op7418",
    });
    expect(parseSocialSource("https://twitter.com/jack/status/20")?.platform).toBe("x");
  });

  it("X 的非用户路径（/i/、/home）不当作 handle", () => {
    expect(parseSocialSource("https://x.com/i/status/123")).toBeNull();
    expect(parseSocialSource("https://x.com/home")).toBeNull();
  });

  it("识别微博链接（数字 uid）", () => {
    expect(parseSocialSource("https://weibo.com/1234567890/ABCdef")).toEqual({
      platform: "weibo",
      handle: "1234567890",
      profileUrl: "https://weibo.com/u/1234567890",
    });
    expect(parseSocialSource("https://m.weibo.cn/u/1234567890")?.handle).toBe("1234567890");
  });

  it("识别 Bluesky 链接", () => {
    expect(
      parseSocialSource("https://bsky.app/profile/kue.bsky.social/post/3kabc"),
    ).toEqual({
      platform: "bluesky",
      handle: "kue.bsky.social",
      profileUrl: "https://bsky.app/profile/kue.bsky.social",
    });
  });

  it("识别 Mastodon 链接", () => {
    expect(parseSocialSource("https://mastodon.social/@Gargron@mastodon.social/123")).toEqual({
      platform: "mastodon",
      handle: "Gargron@mastodon.social",
      profileUrl: "https://mastodon.social/@Gargron",
    });
  });

  it("普通站点、空值、坏链接返回 null", () => {
    expect(parseSocialSource("https://sspai.com/post/123")).toBeNull();
    expect(parseSocialSource("https://blog.cloudflare.com/foo")).toBeNull();
    expect(parseSocialSource(null)).toBeNull();
    expect(parseSocialSource("not a url")).toBeNull();
  });
});
