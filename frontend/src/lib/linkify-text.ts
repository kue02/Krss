/**
 * 正文里「裸 URL」的自动识别（45 批）。
 *
 * 上游源给正文时口径不一：RSSHub 的 Twitter 路由把链接吐成**纯文本**，Telegram /
 * 多数站点吐 `<a>`。渲染管道（`lib/parse-html.ts`）只认标签，于是同一份内容里
 * 「有的链接能点、有的不能」——看着玄学，实际取决于上游赏不赏饭吃。
 * 真库实测：2321 条有正文的条目里 **1353 条（58%）正文含裸 http(s)**，
 * 社交视图的 Twitter 源 255 条里 **212 条带裸 URL、0 条带 `<a>`**。
 *
 * 这里做成**纯函数**：只处理「一段文本里有哪些 URL、各占哪个区间」，
 * 不碰 DOM / hast，方便单测；hast 侧接入在 `lib/parse-html.ts` 的插件里。
 */

/**
 * URL 里允许出现的字符（RFC 3986 保留 + 未保留 + 常见实践）。
 *
 * 故意不含：空白、`<` `>` `"` `&`——前三个在 HTML 里会破坏标签/属性，
 * `&` 已被实体化（`&amp;` 之类）。中文也不在内：库里 150 处裸 URL 抽样，
 * **紧跟字符没有一处是中日韩文字或全角标点**（源在 URL 与中文之间放空格或 `<br>`），
 * 所以不必做 CJK 边界特判。
 */
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";

/** 匹配裸 URL（必须带 http:// 或 https:// scheme，相对路径不猜） */
const BARE_URL_RE = new RegExp(`https?://${URL_CHARS}+`, "gi");

/**
 * 尾标点：英文句子把 URL 直接押尾时会给它戴上句读，也可能被括号/引号包住。
 * 例：`（见 https://a.com/x.）` → 应链接到 `https://a.com/x`
 *
 * 单引号 `'` **不在**其列：它在 URL 里是合法字符（GitHub 仓库名
 * `https://github.com/o/r's`），一刀切去掉会把合法 URL 截断。
 */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}"'’”>，。；：！？、）》」』]+$/;

/** URL 前面被引号/括号包住时，尖括号类要在「开头」也修掉（`<https://x.com>`） */
const LEADING_PUNCT_RE = /^[<"'‘“（(「『【]+/;

export interface BareUrlMatch {
  /** 链接地址（修剪过尾标点） */
  href: string;
  /** 在原文中的起止下标 [start, end)——含首尾的引号/括号不算在内 */
  start: number;
  end: number;
  /**
   * 链接区段之前、同属这个 URL 的首部装饰字符数（左引号/左括号）。
   * 由调用方决定要不要把它并进链接文本；用下标算就行（start - leading）。
   */
  leading: number;
}

/**
 * 在一段纯文本里找出所有裸 URL。
 *
 * - 至少要有「一个点」在 host 里才算（挡住 `https://` 后面什么都没跟的残句）
 * - 尾标点修剪后 host 必须仍是合法域名/IP（可选端口）
 */
export function findBareUrls(text: string): BareUrlMatch[] {
  const out: BareUrlMatch[] = [];
  for (const match of text.matchAll(BARE_URL_RE)) {
    const raw = match[0];
    const trimmed = raw.replace(TRAILING_PUNCT_RE, "");
    if (!trimmed) continue;
    if (!hasValidUrlShape(trimmed)) continue;

    // 尾标点修剪了多少，链接文本就少多少；原始匹配末尾的标点留给后面当普通文本
    const end = match.index + trimmed.length;
    // 左装饰只在「剥完尾标点后仍然紧跟」时才算，避免把 (https://x.com) 的左括号
    // 也算进来导致 e.g. "(https://x.com)" 的右括号被剥而左括号没有
    let leading = 0;
    if (trimmed[0] === "<") {
      // 匹配正则从 https:// 起，尖括号不可能在匹配内；这里只做防御
      leading = 0;
    }
    out.push({ href: trimmed, start: match.index, end, leading });
  }
  return out;
}

/**
 * 粗验 URL 形状：scheme + host + 可选端口。
 * 不用 `new URL()` —— 它对 host 的宽容度在不同浏览器不一，且我们只关心
 * 「点后面是不是有个像域名的东西」，其余交给浏览器。
 */
function hasValidUrlShape(url: string): boolean {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return false;
  const afterScheme = url.slice(schemeEnd + 3);
  if (!afterScheme) return false;
  // IPv6 字面量（[::1]）：`[` 起头的整段到 `]` 为止，后面才可能是 `:port` 或 `/path`
  const ipv6 = /^\[[^\]]+\]/.exec(afterScheme);
  if (ipv6) {
    const rest = afterScheme.slice(ipv6[0].length);
    if (/^\[[0-9a-fA-F:.]+\]$/.test(ipv6[0])) {
      // [::1] 后面只能跟端口或路径/查询/锚点，也可以是结尾
      return rest === "" || /^:\d+([/?#]|$)/.test(rest);
    }
    return false;
  }
  // host = 到第一个 / ? # 之前
  const hostEnd = afterScheme.search(/[/?#]/);
  const host = hostEnd === -1 ? afterScheme : afterScheme.slice(0, hostEnd);
  if (!host) return false;
  // 用户信息 @ 前缀（https://user@example.com）：取 @ 后那段
  const at = host.lastIndexOf("@");
  const hostPart = at === -1 ? host : host.slice(at + 1);
  if (!hostPart) return false;
  // 端口
  const colon = hostPart.indexOf(":");
  const port = colon === -1 ? "" : hostPart.slice(colon + 1);
  const hostNoPort = colon === -1 ? hostPart : hostPart.slice(0, colon);
  if (colon !== -1 && !/^\d+$/.test(port)) return false;
  // 域名：至少一段「点」，每段是字母数字连字符；或是 localhost / IPv4
  return isPlausibleHost(hostNoPort);
}

function isPlausibleHost(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (!host.includes(".")) return false;
  // 每段非空、只含字母数字连字符，且至少有一段不是纯数字
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const allLabelOk = labels.every((label) => /^[A-Za-z0-9-]+$/.test(label));
  if (!allLabelOk) return false;
  const hasAlpha = labels.some((label) => /[A-Za-z]/.test(label));
  if (!hasAlpha) return false;
  // 末段（TLD）至少两个字母 —— 挡住 `http://192.168.1` 这类被截断的端口串
  const tld = labels[labels.length - 1] ?? "";
  return tld.length >= 2;
}

/**
 * 去掉被引号/括号包住的首部装饰（仅用于统计/展示，不改 href）。
 * `findBareUrls` 的匹配从 `https://` 起，所以这些字符本来就不在匹配内；
 * 导出它给「要不要把左括号并进链接」这类决策用。
 */
export function stripLeadingDecorations(text: string): string {
  return text.replace(LEADING_PUNCT_RE, "");
}
