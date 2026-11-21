import { AlertTriangle, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 「当前这段文字是机器翻译」的小标记（54-5，用户 2026-10-20 拍板要加）。
 *
 * 为什么要有它：卡片正文在自动翻译生效时会**顶替**成译文（54-3/54-4），
 * 界面上看不出这份内容已经不是原文了 —— 译文有偏差时用户会以为是源站写错。
 * 一个 12px 的语言图标 + tooltip 就够，不占版面也不打断阅读。
 *
 * ## 三态（REQ3）
 *
 * - `done`（默认）：当前显示的确实是译文，语言图标 + 「机器翻译」，保持历史外观；
 * - `translating`：正在翻，图标套 `ai-icon-thinking-wrapper` 扫光动画 + 「翻译中…」；
 * - `failed`：翻失败，红色警告图标 + 「翻译失败」，hover（title）显示后端给的具体错误。
 *
 * 由调用方根据 store 里的内容 / 状态决定传哪个 state；默认 `done` 兼容旧调用点。
 */
export type MachineTranslatedBadgeState = "translating" | "done" | "failed";

export function MachineTranslatedBadge({
  state = "done",
  error,
  className,
}: {
  state?: MachineTranslatedBadgeState;
  error?: string;
  className?: string;
}) {
  const { t } = useTranslation();

  if (state === "translating") {
    const label = t("entry.translating");
    return (
      <span
        data-machine-translated=""
        data-translation-state="translating"
        className={cn(
          "inline-flex shrink-0 items-center text-muted-foreground/70",
          className,
        )}
        title={label}
        aria-label={label}
        role="img"
      >
        <span className="ai-icon-thinking-wrapper">
          <Languages className="size-3.5" aria-hidden="true" />
        </span>
      </span>
    );
  }

  if (state === "failed") {
    const label = t("entry.translate_failed");
    return (
      <span
        data-machine-translated=""
        data-translation-state="failed"
        className={cn(
          "inline-flex shrink-0 items-center text-destructive",
          className,
        )}
        title={error || label}
        aria-label={error || label}
        role="img"
      >
        <AlertTriangle className="size-3.5" aria-hidden="true" />
      </span>
    );
  }

  const label = t("entry.machine_translated");
  return (
    <span
      data-machine-translated=""
      data-translation-state="done"
      className={cn(
        "inline-flex shrink-0 items-center text-muted-foreground/70",
        className,
      )}
      title={label}
      aria-label={label}
      role="img"
    >
      <Languages className="size-3.5" aria-hidden="true" />
    </span>
  );
}
