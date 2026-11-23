import { useState } from "react";
import type { SyntheticEvent } from "react";
import { Popover } from "@heroui/react";
import { Languages, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";

/**
 * 「当前这段文字是机器翻译」的小标记（54-5，用户 2026-10-20 拍板要加）。
 *
 * 为什么要有它：卡片正文在自动翻译生效时会**顶替**成译文（54-3/54-4），
 * 界面上看不出这份内容已经不是原文了 —— 译文有偏差时用户会以为是源站写错。
 * 一个 12px 的语言图标 + 说明就够，不占版面也不打断阅读。
 *
 * ## 三态（REQ3）
 *
 * - `done`（默认）：当前显示的确实是译文，语言图标 + 所用服务，保持历史外观；
 * - `translating`：正在翻，图标套 `ai-icon-thinking-wrapper` 扫光动画 + 「翻译中…」；
 * - `failed`：翻失败，红色警告图标 + 「翻译失败」，点开/悬浮显示后端给的具体错误。
 *
 * 说明的触发方式：桌面端 hover Tooltip；移动端点一下就地弹 HeroUI Popover，
 * 再点一次或点空白收起。两端都只挂一套 DOM（用 `useIsMobile` 分支）。
 */
export type MachineTranslatedBadgeState = "translating" | "done" | "failed";

/**
 * `summary` 用「摘要翻译」专用兜底文案；`ai-summary` 表示这条目有 AI 摘要（灯泡图标）；
 * 其余（正文）用通用文案。
 */
export type MachineTranslatedBadgeVariant =
  | "translation"
  | "summary"
  | "ai-summary";

/**
 * 完成态只显示「用了什么」，不再附加「机器翻译 / 摘要翻译 / Google 翻译」这类 label：
 * 有 model → `provider · model`（provider 缺失就只 model）；
 * 无 model 但有 provider → 只 provider；
 * provider / model 都没有、只有 service → 只 service；
 * 三者都没有 → null（调用方退回旧 label 兜底）。
 */
export function describeUsage({
  service,
  provider,
  model,
}: {
  service?: string;
  provider?: string;
  model?: string;
}): string | null {
  const providerText = provider?.trim();
  const modelText = model?.trim();

  if (modelText) {
    return providerText && providerText !== modelText
      ? `${providerText} · ${modelText}`
      : modelText;
  }
  if (providerText) return providerText;

  const serviceText = service?.trim();
  return serviceText || null;
}

/**
 * 图标本身只有 14px，直接点很难命中。用绝对定位伪元素把热区扩到 40×40：
 * 水平左右各 13px；垂直向上 18px、向下 8px（向下只到作者行底部，不压住下方标题）。
 * 伪元素不参与布局，所以不会把作者行（leading-6）撑高。
 */
const TOUCH_TARGET_CLASS =
  "relative before:absolute before:-left-[13px] before:-right-[13px] before:-top-[18px] before:-bottom-[8px] before:content-['']";

/** 徽标嵌在可点卡片里：这一下既不能开详情，也不能触发卡片长按菜单。 */
function stopCardInteraction(event: SyntheticEvent) {
  event.stopPropagation();
}

export function MachineTranslatedBadge({
  state = "done",
  error,
  service,
  provider,
  model,
  className,
  variant = "translation",
}: {
  state?: MachineTranslatedBadgeState;
  error?: string;
  service?: string;
  provider?: string;
  model?: string;
  className?: string;
  variant?: MachineTranslatedBadgeVariant;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const isAISummary = variant === "ai-summary";
  const isSummary = variant === "summary" || isAISummary;
  const Icon = isAISummary ? Lightbulb : Languages;

  const fallbackLabel = isAISummary
    ? t("entry.ai_summary")
    : isSummary
      ? t("entry.summary_translated")
      : t("entry.machine_translated");

  let message: string;
  if (state === "translating") {
    message = t(
      isSummary ? "entry.summary_translating" : "entry.translating",
    );
  } else if (state === "failed") {
    const failedLabel = t(
      isSummary ? "entry.summary_translate_failed" : "entry.translate_failed",
    );
    message = error?.trim() || failedLabel;
  } else {
    message = describeUsage({ service, provider, model }) ?? fallbackLabel;
  }

  const toneClass =
    state === "failed" ? "text-destructive" : "text-muted-foreground/70";
  const icon =
    state === "translating" ? (
      <span className="ai-icon-thinking-wrapper">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
    ) : (
      <Icon className="size-3.5" aria-hidden="true" />
    );

  if (isMobile) {
    return (
      <Popover.Root isOpen={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger
          data-machine-translated=""
          data-translation-state={state}
          aria-label={message}
          className={cn(
            "inline-flex shrink-0 items-center",
            TOUCH_TARGET_CLASS,
            toneClass,
            className,
          )}
          onClick={stopCardInteraction}
          onPointerDown={stopCardInteraction}
          onTouchStart={stopCardInteraction}
        >
          {icon}
        </Popover.Trigger>
        {/* 点空白/再点徽标即可关闭；模态能确保背景不误触列表 */}
        <Popover.Content placement="top">
          <Popover.Dialog className="max-w-[min(18rem,calc(100vw-2rem))] px-3 py-2 text-xs leading-relaxed text-popover-foreground">
            {message}
          </Popover.Dialog>
        </Popover.Content>
      </Popover.Root>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-machine-translated=""
          data-translation-state={state}
          className={cn(
            "inline-flex shrink-0 items-center",
            TOUCH_TARGET_CLASS,
            toneClass,
            className,
          )}
          aria-label={message}
          role="img"
          onClick={stopCardInteraction}
          onPointerDown={stopCardInteraction}
          onTouchStart={stopCardInteraction}
        >
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}
