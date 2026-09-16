import { useTranslation } from "react-i18next";

interface OriginalSiteViewProps {
  url: string;
}

/**
 * 在阅读栏里直接加载原站（#13）。
 *
 * 说明：浏览器里只能用 iframe 内嵌，很多站点会发 X-Frame-Options / CSP frame-ancestors 拒绝，
 * 那种情况 iframe 会是一片空白且前端无法可靠探测，所以顶部常驻一条提示 + 新窗口打开的出口。
 */
export function OriginalSiteView({ url }: OriginalSiteViewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {t("entry.original_site_hint")}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-full border border-border px-2.5 py-1 transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
        >
          {t("entry.open_in_new_tab")}
        </a>
      </div>
      <iframe
        src={url}
        title={t("entry.original_site")}
        className="min-h-0 flex-1 bg-surface"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
