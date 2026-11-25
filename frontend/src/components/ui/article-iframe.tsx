import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { ExternalLink, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUISettingKey } from "@/hooks/useUISettings";
import { hostMatchesRules, mergeIframeVideoHosts } from "@/lib/video-embed";

/**
 * 正文里的 `<iframe>` 视频（bilibili / YouTube / Wistia 等）。
 *
 * 参考 NextFlux `ArticleView/components/Iframe.jsx`：
 * - bilibili：从原始地址取 `bvid`，统一改写为黑板 HTML5 播放器
 *   （`www.bilibili.com/blackboard/html5mobileplayer.html?...`），否则 RSSHub
 *   给的 `player.bilibili.com/player.html` 在部分环境会白屏或被拒嵌；
 * - YouTube：`watch?v=` / `youtu.be/<id>` / 已有 `/embed/<id>` 统一归一成
 *   `www.youtube.com/embed/<id>?...&playsinline=1`（顺带修 RSSHub 里 `&quot;` 混进 id 的脏数据；
 *   `playsinline` 是 iOS 内联播放所需，`www.youtube.com` 便于复用已登录会话）；
 * - Wistia 原样；
 * - 其它域名：默认给「点击加载」占位，点一下才挂 iframe；用户可在设置里把站点加进白名单直接内嵌，
 *   或关掉「未知站点点击加载」回到「域名 + ↗」外链。
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

function isAllowedHost(
  hostname: string,
  extraHosts: readonly string[] = [],
): boolean {
  return hostMatchesRules(hostname, mergeIframeVideoHosts(extraHosts));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 畸形 % 序列（如 /embed/100%pure）不能让它抛 URIError 把整篇正文渲染带崩。
    return value;
  }
}

/** RSSHub 的 YouTube 数据里会混进 `&quot;` 或被 URL 编码成 %22，统一清掉再校验。 */
function cleanYouTubeId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const id = safeDecode(value)
    .replace(/&quot;/g, '"')
    .replace(/^["'\s]+|["'\s]+$/g, "");
  return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : undefined;
}

function extractYouTubeId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const parts = safeDecode(url.pathname).split("/").filter(Boolean);
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
export function resolveIframeSrc(
  raw: string | undefined,
  extraHosts: readonly string[] = [],
): string | null {
  const url = toHttpUrl(raw);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  if (!isAllowedHost(host, extraHosts)) return null;

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
    if (!id) return null; // playlist / 频道页等无法内嵌，交给外链降级，别塞原始页白屏
    const start = url.searchParams.get("t") ?? url.searchParams.get("start");
    // 用 www.youtube.com 而不是 youtube-nocookie：与 NextFlux/Miniflux 一致，
    // 已登录 Google 的浏览器能复用会话，移动端也更少触发「确认你不是机器人」；
    // playsinline 是 iOS Safari 内联播放的必要参数（否则会强制全屏/无法点播）。
    const params = new URLSearchParams({
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
    });
    if (start && /^\d+$/.test(start)) params.set("start", start);
    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
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

function isTinyOrHidden(
  width: string | number | undefined,
  height: string | number | undefined,
  style: React.CSSProperties | string | undefined,
  hidden: boolean | undefined,
): boolean {
  const w = Number(width);
  const h = Number(height);
  if (Number.isFinite(w) && w <= 1) return true;
  if (Number.isFinite(h) && h <= 1) return true;
  if (hidden) return true;
  if (typeof style === "string") return /display\s*:\s*none/i.test(style);
  if (style && typeof style === "object" && style.display === "none") return true;
  return false;
}

export function ArticleIframe({
  src,
  title,
  className,
  style,
  width,
  height,
  hidden,
  ...rest
}: ArticleIframeProps) {
  const { t } = useTranslation();
  const extraHosts = useUISettingKey("iframeVideoHosts") ?? [];
  const unknownClickToLoad =
    useUISettingKey("iframeUnknownClickToLoad") !== false;
  // 「点击加载」后放行原 iframe。state 放在所有 return 之前，钩子顺序才稳定。
  const [activated, setActivated] = useState(false);

  const resolved = resolveIframeSrc(src, extraHosts);
  const rawSrcUrl = toHttpUrl(src)?.toString() ?? null;
  const srcHost = toHttpUrl(src)?.hostname ?? "";
  // 已知站点但解析失败（YouTube playlist / 畸形 id）不能再给「点击加载」——
  // 那种原始页塞进 iframe 只会被 X-Frame-Options 拒成黑块，仍旧降级外链。
  const knownHost = srcHost ? isAllowedHost(srcHost, extraHosts) : false;

  if (!resolved) {
    // 追踪像素 / 广告位常是 1×1 或 display:none 的 iframe，不降级成可见药丸。
    if (isTinyOrHidden(width, height, style, hidden)) return null;
    const fallback = getFallback(src);
    if (!fallback) return null;

    // 未知站点 iframe：用户开了「点击加载」时，不直接丢弃，给一个 16:9 播放位，
    // 点一下才真正挂 iframe（避免一打开文章就被第三方追踪 / 跑到未知站点）。
    if (unknownClickToLoad && !knownHost && rawSrcUrl && !activated) {
      return (
        <div
          data-slot="article-iframe-placeholder"
          className={cn("article-iframe not-prose my-4 w-full", className)}
          style={style}
        >
          <Button
            variant="ghost"
            onPress={() => setActivated(true)}
            className="h-auto w-full min-w-0 rounded-[var(--radius-lg)] border border-border/60 bg-secondary/40 p-0 text-muted-foreground hover:bg-secondary/60"
            aria-label={t("article_iframe.click_to_load", {
              host: fallback.host,
            })}
          >
            <span className="flex aspect-video w-full flex-col items-center justify-center gap-2">
              <span className="flex size-12 items-center justify-center rounded-full bg-background/70 text-foreground shadow-nf-sm">
                <Play className="size-5 translate-x-0.5" aria-hidden="true" />
              </span>
              <span className="text-xs font-medium text-foreground">
                {t("article_iframe.click_to_load_short")}
              </span>
              <span className="text-[11px] opacity-70">{fallback.host}</span>
            </span>
          </Button>
        </div>
      );
    }

    const embedSrc = activated && rawSrcUrl ? rawSrcUrl : null;
    if (embedSrc) {
      return (
        <div
          data-slot="article-iframe"
          className={cn("article-iframe not-prose my-4 w-full", className)}
          style={style}
        >
          <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-lg)] bg-black">
            <iframe
              {...rest}
              src={embedSrc}
              title={title || fallback.host}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox={IFRAME_SANDBOX}
              allow={DEFAULT_ALLOW}
              allowFullScreen
              className="absolute inset-0 h-full w-full border-0"
            />
          </div>
        </div>
      );
    }

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
          allow={DEFAULT_ALLOW}
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
    </div>
  );
}
