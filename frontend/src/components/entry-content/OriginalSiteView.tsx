import { useState } from "react";
import { useTranslation } from "react-i18next";

interface OriginalSiteViewProps {
  url: string;
}

/**
 * 在阅读栏里直接加载原站。
 *
 * 说明：浏览器里只能用 iframe 内嵌，很多站点会发 X-Frame-Options / CSP frame-ancestors 拒绝，
 * 那种情况 iframe 会是一片空白且前端无法可靠探测，所以解析完成前给状态、完成后留一个出口。
 *
 * 修过的坑：
 * 1. 正文头部（EntryContentHeader）是 absolute 覆盖在内容之上的，这里必须自己让出 48px，
 *    否则提示条会被头部工具条压住（「新标签页打开」也被盖）。
 * 2. 之前那行提示是常驻的整宽栏（py-2），加载完了还白占一行高度（用户：「占了太大空间」）。
 *    现在只在加载中显示细条（py-1 + 转圈），加载完成后整条不再占版面，
 *    出口收成右上角悬浮小胶囊 —— 空白原因（站点拒绝内嵌）写在它的 title 里。
 */
export function OriginalSiteView({ url }: OriginalSiteViewProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div className="flex h-full min-h-0 w-full flex-col pt-12">
      {isLoading && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1 text-xs text-muted-foreground">
          <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
          <span className="min-w-0 truncate">{t("entry.original_site_loading")}</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          src={url}
          title={t("entry.original_site")}
          onLoad={() => setIsLoading(false)}
          className="size-full bg-surface"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
        {!isLoading && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={t("entry.original_site_hint")}
            className="absolute right-3 top-3 rounded-full border border-border bg-overlay/90 px-2.5 py-1 text-xs text-muted-foreground shadow-nf-md backdrop-blur-md transition-colors duration-200 hover:text-foreground"
          >
            {t("entry.open_in_new_tab")}
          </a>
        )}
      </div>
    </div>
  );
}
