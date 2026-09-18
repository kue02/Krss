import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ProxyEffective } from "@/types/api";

/**
 * 一行「实际生效结果」（14 批验收口径）：
 *
 *   走代理 · 来自：文件夹「技术」
 *   直连 · 来自：订阅设置
 *   跟随全局 · 走代理
 *
 * 刻意显示**结果**而不是「你选了什么」—— 覆盖链是「订阅 → 文件夹（含父级链）→ 全局」，
 * 只有把决定它的那一层也写出来，用户才不用猜（选了「走代理」但全局没配时，这里会写明实际是直连）。
 */
export function ProxyEffectiveLine({
  effective,
  className,
}: {
  effective?: ProxyEffective | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!effective) return null;

  const isProxy = effective.mode === "proxy";
  const result = isProxy ? t("proxy.result_proxy") : t("proxy.result_direct");

  let origin: string;
  switch (effective.source) {
    case "feed":
      origin = t("proxy.from_feed");
      break;
    case "folder":
      origin = t("proxy.from_folder", { name: effective.sourceName ?? "" });
      break;
    default:
      origin = t("proxy.from_global");
      break;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        isProxy
          ? "border-primary/40 text-primary"
          : "border-border text-muted-foreground",
        className,
      )}
      data-slot="proxy-effective"
      data-mode={effective.mode}
      data-source={effective.source}
    >
      <span>
        {result} · {origin}
      </span>
      {/* 选了「走代理」却拿不到可用地址 → 说明一句，别让人以为是 bug */}
      {effective.missing && (
        <span className="text-muted-foreground">
          （{t("proxy.missing_config")}）
        </span>
      )}
    </span>
  );
}
