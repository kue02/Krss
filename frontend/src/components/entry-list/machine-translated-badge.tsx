import { AlertTriangle, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * - `failed`：翻失败，红色警告图标 + 「翻译失败」，hover 显示后端给的具体错误。
 *
 * 悬浮说明统一走 HeroUI Tooltip（AGENTS：优先 HeroUI），失败态在悬浮里看到具体错误。
 */
export type MachineTranslatedBadgeState = "translating" | "done" | "failed";

/** `summary` 用「摘要」专用文案，其余（正文）用通用文案。 */
export type MachineTranslatedBadgeVariant = "translation" | "summary";

export function MachineTranslatedBadge({
  state = "done",
  error,
  className,
  variant = "translation",
}: {
  state?: MachineTranslatedBadgeState;
  error?: string;
  className?: string;
  variant?: MachineTranslatedBadgeVariant;
}) {
  const { t } = useTranslation();
  const isSummary = variant === "summary";

  if (state === "translating") {
    const label = t(
      isSummary ? "entry.summary_translating" : "entry.translating",
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-machine-translated=""
            data-translation-state="translating"
            className={cn(
              "inline-flex shrink-0 items-center text-muted-foreground/70",
              className,
            )}
            aria-label={label}
            role="img"
          >
            <span className="ai-icon-thinking-wrapper">
              <Languages className="size-3.5" aria-hidden="true" />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }

  if (state === "failed") {
    const label = t(
      isSummary ? "entry.summary_translate_failed" : "entry.translate_failed",
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-machine-translated=""
            data-translation-state="failed"
            className={cn(
              "inline-flex shrink-0 items-center text-destructive",
              className,
            )}
            aria-label={error || label}
            role="img"
          >
            <AlertTriangle className="size-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{error || label}</TooltipContent>
      </Tooltip>
    );
  }

  const label = isSummary
    ? t("entry.summary_translated")
    : t("entry.machine_translated");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-machine-translated=""
          data-translation-state="done"
          className={cn(
            "inline-flex shrink-0 items-center text-muted-foreground/70",
            className,
          )}
          aria-label={label}
          role="img"
        >
          <Languages className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
