/**
 * 判断抓回来的「正文」是不是垃圾。
 *
 * 实测：对社交源（X）调 fetch-readable，拿到的是未登录落地页
 * （"See what's happening and join the conversation / Log in / Sign up"），
 * 比源里的推文原文还差；付费墙、验证页同理。这类结果一律丢弃，保留源内容。
 */

const JUNK_MARKERS = [
  "see what's happening and join the conversation",
  "log in",
  "sign up",
  "continue with phone",
  "enable javascript",
  "just a moment",
  "checking your browser",
  "verify you are human",
  // X 抓取页的标题形态：`某某 on X: "推文…"`，正文其实是页面骨架
  'on x: "',
  "on x: “",
  "please turn javascript on",
  "subscribe to continue reading",
  "this content is for subscribers",
  "登录后继续",
  "请登录后",
  "扫码登录",
  "验证码",
  "无访问权限",
];

/** 太短的结果大概率只是导航/页脚残渣 */
const MIN_USEFUL_CHARS = 200;

export function looksLikeJunkContent(
  html: string | null | undefined,
): boolean {
  if (!html) return true;

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < MIN_USEFUL_CHARS) return true;

  const lowered = text.toLowerCase();
  let hits = 0;
  for (const marker of JUNK_MARKERS) {
    if (lowered.includes(marker)) hits += 1;
  }

  // 命中 2 个以上特征词才判定为垃圾，避免误伤正文里恰好提到「登录」的文章
  return hits >= 2;
}
