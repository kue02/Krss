import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 正文里的 `<iframe>` 视频（bilibili / YouTube / Wistia 等）。
 *
 * 参考 NextFlux `ArticleView/components/Iframe.jsx`：
 * - bilibili：从原始地址取 `bvid`，统一改写为黑板 HTML5 播放器
 *   （`www.bilibili.com/blackboard/html5mobileplayer.html?...`），否则 RSSHub
 *   给的 `player.bilibili.com/player.html` 在部分环境会白屏或被拒嵌；
 * - YouTube：`watch?v=` / `youtu.be/<id>` / 已有 `/embed/<id>` 统一归一成
 *   `www.youtube-nocookie.com/embed/<id>`（顺带修 RSSHub 里 `&quot;` 混进 id 的脏数据）；
 * - Wistia 原样；
 * - 其它域名一律不嵌，降级成「域名 + ↗」外链，避免把任意第三方 iframe 引进正文。
 *
 * 渲染层固定 16:9、懒加载、`referrerPolicy=strict-origin-when-cross-origin`，
 * 并用 `sandbox` 收住脚本能力（视频站需要的 allow-scripts / allow-same-origin /
 * allow-presentation / allow-popups 才放）。
 */

function toHttpUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;
  // RSSHub / 老 feed 常见协议相对地址：//player.bilibili.com/...
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "youtu.be" ||
    host === "fast.wistia.net" ||
    host.endsWith(".wistia.net")
  );
}

/** RSSHub 的 YouTube 数据里会混进 `&quot;` 或被 URL 编码成 %22，统一清掉再校验。 */
function cleanYouTubeId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const id = decodeURIComponent(value)
    .replace(/&quot;/g, '"')
    .replace(/^["'\s]+|["'\s]+$/g, "");
  return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : undefined;
}

function extractYouTubeId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  let id: string | undefined;

  if (host === "youtu.be") {
    id = parts[0];
  } else if (
    parts[0] === "embed" ||
    parts[0] === "shorts" ||
    parts[0] === "v" ||
    parts[0] === "live"
  ) {
    id = parts[1];
  } else if (parts[0] === "watch") {
    id = url.searchParams.get("v") ?? undefined;
  }

  return cleanYouTubeId(id);
}

/** 把正文里的 iframe 地址归一成可安全内嵌的地址；不在白名单 / 非 http(s) 返回 null。 */
export function resolveIframeSrc(raw: string | undefined): string | null {
  const url = toHttpUrl(raw);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  if (!isAllowedHost(host)) return null;

  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    const bvid =
      url.searchParams.get("bvid") ??
      url.pathname.match(/BV[0-9A-Za-z]+/)?.[0];
    if (bvid) {
      return `https://www.bilibili.com/blackboard/html5mobileplayer.html?isOutside=true&bvid=${encodeURIComponent(
        bvid,
      )}&p=1&hideCoverInfo=1&danmaku=0`;
    }
    return url.toString();
  }

  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  ) {
    const id = extractYouTubeId(url);
    if (id) {
      const start = url.searchParams.get("t") ?? url.searchParams.get("start");
      const params = new URLSearchParams({ rel: "0", modestbranding: "1" });
      if (start && /^\d+$/.test(start)) params.set("start", start);
      return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
    }
  }

  return url.toString();
}

function getFallback(raw: string | undefined): { href: string; host: string } | null {
  const url = toHttpUrl(raw);
  if (!url) return null;
  return { href: url.toString(), host: url.hostname };
}

const DEFAULT_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen";
const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

export interface ArticleIframeProps
  extends React.IframeHTMLAttributes<HTMLIFrameElement> {
  src?: string;
}

export function ArticleIframe({
  src,
  title,
  className,
  style,
  allow,
  ...rest
}: ArticleIframeProps) {
  const resolved = resolveIframeSrc(src);

  if (!resolved) {
    const fallback = getFallback(src);
    if (!fallback) return null;
    return (
      <div
        data-slot="article-iframe-fallback"
        className="not-prose my-4 flex w-full justify-center"
      >
        <a
          href={fallback.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-transparent bg-secondary px-2 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
        >
          <span className="truncate">{fallback.host}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
      </div>
    );
  }

  return (
    <div
      data-slot="article-iframe"
      className={cn("article-iframe not-prose my-4 w-full", className)}
      style={style}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-lg)] bg-black">
        <iframe
          {...rest}
          src={resolved}
          title={title || "Embedded video"}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox={IFRAME_SANDBOX}
          allow={allow || DEFAULT_ALLOW}
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
    </div>
  );
}
