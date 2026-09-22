import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 三态开关：跟随上级 / A / B。
 *
 * 从 EditFeedDialog 里抽出来的（14 批要复用：订阅与文件夹的代理档位也是同一套三态语汇），
 * 抽的时候行为一字未动 —— 只是把「跟随全局」那句文案变成可覆盖的 inheritLabel
 * （代理这一层的上级是「父级文件夹 → 全局」，写「跟随全局」不准确）。
 */
export function TriStateControl({
  value,
  onChange,
  inheritLabel,
  onLabel,
  offLabel,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  /** null 那一档的文案，默认「跟随全局」 */
  inheritLabel?: string;
  /** true 那一档的文案，默认「开」（正文打开方式用它显示「阅读模式」） */
  onLabel?: string;
  /** false 那一档的文案，默认「关」 */
  offLabel?: string;
}) {
  const { t } = useTranslation();
  const options: { value: boolean | null; label: string }[] = [
    { value: null, label: inheritLabel ?? t("feeds.follow_global") },
    { value: true, label: onLabel ?? t("feeds.on") },
    { value: false, label: offLabel ?? t("feeds.off") },
  ];

  return (
    <div className="flex shrink-0 gap-1 rounded-full border border-border p-0.5">
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs transition-colors duration-200",
              isActive
                ? "bg-item-active text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
