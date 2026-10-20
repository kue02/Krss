import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 「当前这段文字是机器翻译」的小标记（54-5，用户 2026-10-20 拍板要加）。
 *
 * 为什么要有它：卡片正文在自动翻译生效时会**顶替**成译文（54-3/54-4），
 * 界面上看不出这份内容已经不是原文了 —— 译文有偏差时用户会以为是源站写错。
 * 一个 12px 的语言图标 + tooltip 就够，不占版面也不打断阅读。
 *
 * 只在「本条当前显示的确实是译文」时才渲染，由调用方判断：
 * 判据是 `translation?.content` 非空（即 store 里有整篇译文），**不是**
 * 「自动翻译开着」—— 开着但还没翻好的条目显示的仍是原文，这时挂图标是错的。
 */
export function MachineTranslatedBadge({
  className,
}: {
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t("entry.machine_translated");
  return (
    <span
      data-machine-translated=""
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
