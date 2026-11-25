import { describe, expect, it } from "vitest";
import {
  BUILTIN_IFRAME_VIDEO_HOSTS,
  hostMatchesRules,
  isDirectVideoUrl,
  mergeIframeVideoHosts,
  normalizeIframeVideoHost,
} from "./video-embed";

describe("video-embed · 直链视频与 iframe 白名单", () => {
  it("识别常见直接视频文件扩展名", () => {
    expect(isDirectVideoUrl("https://cdn.example.com/a/b.mp4")).toBe(true);
    expect(isDirectVideoUrl("https://cdn.example.com/a/b.WEBM?token=1")).toBe(true);
    expect(isDirectVideoUrl("//cdn.example.com/live/index.m3u8")).toBe(true);
    expect(isDirectVideoUrl("https://example.com/video.mp4.jpg")).toBe(false);
    expect(isDirectVideoUrl("https://example.com/article/123")).toBe(false);
    expect(isDirectVideoUrl("javascript:alert(1)")).toBe(false);
    expect(isDirectVideoUrl(undefined)).toBe(false);
  });

  it("归一用户填写的站点（域名 / 完整 URL / 通配前缀）", () => {
    expect(normalizeIframeVideoHost("example.com")).toBe("example.com");
    expect(normalizeIframeVideoHost(" https://Video.Example.com/watch?id=1 ")).toBe(
      "video.example.com",
    );
    expect(normalizeIframeVideoHost("//player.example.com:8443/x")).toBe(
      "player.example.com",
    );
    expect(normalizeIframeVideoHost("*.example.com")).toBe("example.com");
    expect(normalizeIframeVideoHost("localhost")).toBeNull();
    expect(normalizeIframeVideoHost("not a host")).toBeNull();
    expect(normalizeIframeVideoHost("")).toBeNull();
  });

  it("host 规则同时匹配根域与子域", () => {
    expect(hostMatchesRules("v.example.com", ["example.com"])).toBe(true);
    expect(hostMatchesRules("example.com", ["example.com"])).toBe(true);
    expect(hostMatchesRules("evilexample.com", ["example.com"])).toBe(false);
    expect(hostMatchesRules("bilibili.com", BUILTIN_IFRAME_VIDEO_HOSTS)).toBe(true);
    expect(hostMatchesRules("player.bilibili.com", BUILTIN_IFRAME_VIDEO_HOSTS)).toBe(
      true,
    );
  });

  it("合并内置与用户白名单，去重并丢弃非法值", () => {
    const merged = mergeIframeVideoHosts(["video.example.com", "video.example.com", "bad host"]);
    expect(merged).toContain("bilibili.com");
    expect(merged).toContain("youtube.com");
    expect(merged).toContain("wistia.net");
    expect(merged.filter((host) => host === "video.example.com")).toHaveLength(1);
    expect(merged).not.toContain("bad host");
  });
});
