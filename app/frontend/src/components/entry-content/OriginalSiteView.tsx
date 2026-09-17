import { useState } from "react";
import { useTranslation } from "react-i18next";

interface OriginalSiteViewProps {
  url: string;
}

/**
 * 在阅读栏里直接加载原站。
 *
 * 说明：浏览器里只能用 iframe 内嵌，很多站点会发 X-Frame-Options / CSP frame-ancestors 拒绝，
 * 那种情况 iframe 会是一片空白且前端无法可靠探测，所以加载完成后留一条提示 + 新窗口打开的出口。
 *
 * 两个修过的坑：
 * 1. 正文头部（EntryContentHeader）是 absolute 覆盖在内容之上的，这里必须自己让出 48px，
 *    否则提示条会被头部工具条压住（「新标签页打开」也被盖）。
 * 2. 之前那行「正在加载原站…」是常驻文案 —— 加载完了也写着"正在加载"，看着像卡住了。
 *    现在只在真的没加载完时显示，onLoad 之后换成「站点可能拒绝内嵌」的说明。
 */
export function OriginalSiteView({ url }: OriginalSiteViewProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div className="flex h-full min-h-0 w-full flex-col pt-12">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {isLoading
            ? t("entry.original_site_loading")
            : t("entry.original_site_hint")}
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
      <div className="relative min-h-0 flex-1">
        <iframe
          src={url}
          title={t("entry.original_site")}
          onLoad={() => setIsLoading(false)}
          className="size-full bg-surface"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
        {isLoading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface/60 text-xs text-muted-foreground">
            {t("entry.loading")}
          </div>
        )}
      </div>
    </div>
  );
}
