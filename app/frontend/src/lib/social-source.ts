/**
 * 从条目链接里认出「这是哪个社交平台、作者是谁」。
 *
 * 对齐 Folo 的 `parseSocialMedia(entry.authorUrl || entry.url || entry.guid)`：
 * 社交视图的条目要显示 `@handle`（可点进作者主页），而不是只显示订阅源名字。
 * Krss 的 entry 没有 authorUrl 字段，所以只看 url。
 */
export type SocialPlatform = "x" | "weibo" | "bluesky" | "mastodon";

export interface SocialSource {
  platform: SocialPlatform;
  /** 不带 @ 的 handle */
  handle: string;
  /** 作者主页 */
  profileUrl: string;
}

const PLATFORM_HOSTS: Record<string, SocialPlatform> = {
  "x.com": "x",
  "www.x.com": "x",
  "twitter.com": "x",
  "www.twitter.com": "x",
  "mobile.twitter.com": "x",
  "weibo.com": "weibo",
  "www.weibo.com": "weibo",
  "m.weibo.cn": "weibo",
  "bsky.app": "bluesky",
  "www.bsky.app": "bluesky",
};

/** 形如 https://host/@user@instance/@… 的 Mastodon 链接 */
const MASTODON_PATH = /^\/@([^/@]+)@([^/]+)/;

export function parseSocialSource(
  url: string | null | undefined,
): SocialSource | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  const platform = PLATFORM_HOSTS[host];

  if (platform === "x") {
    // https://x.com/<handle>/status/<id>
    const handle = segments[0];
    if (!handle || handle === "i" || handle === "home") return null;
    return { platform, handle, profileUrl: `https://x.com/${handle}` };
  }

  if (platform === "weibo") {
    // https://weibo.com/<uid>/<postId> 或 https://m.weibo.cn/u/<uid>
    const handle = segments[0] === "u" ? segments[1] : segments[0];
    if (!handle || !/^\d+$/.test(handle)) return null;
    return { platform, handle, profileUrl: `https://weibo.com/u/${handle}` };
  }

  if (platform === "bluesky") {
    // https://bsky.app/profile/<handle>/post/<id>
    if (segments[0] !== "profile" || !segments[1]) return null;
    const handle = segments[1];
    return { platform, handle, profileUrl: `https://bsky.app/profile/${handle}` };
  }

  const mastodon = parsed.pathname.match(MASTODON_PATH);
  if (mastodon?.[1] && mastodon[2]) {
    const handle = `${mastodon[1]}@${mastodon[2]}`;
    return {
      platform: "mastodon",
      handle,
      profileUrl: `https://${mastodon[2]}/@${mastodon[1]}`,
    };
  }

  return null;
}
