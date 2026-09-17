import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type EntryFilter = "all" | "unread" | "starred" | "muted";

interface EntryListFilterPillProps {
  value: EntryFilter;
  onChange: (value: EntryFilter) => void;
}

const OPTIONS: { id: EntryFilter; labelKey: string }[] = [
  { id: "starred", labelKey: "entry_filter.starred" },
  { id: "unread", labelKey: "entry_filter.unread" },
  { id: "muted", labelKey: "entry_filter.muted" },
  { id: "all", labelKey: "entry_filter.all" },
];

/**
 * 中栏底部的筛选胶囊 —— Nextflux 的标志元素
 *
 * Starred / Unread / Muted / All 四态，选中项为强调色实心胶囊。
 * 前两态接的是 Gist 后端既有的 `starredOnly` / `unreadOnly` 参数；
 * 「已静音」接 v3 新增的 `mutedOnly`（见 EntryList 里的参数翻译）。
 */
export function EntryListFilterPill({
  value,
  onChange,
}: EntryListFilterPillProps) {
  const { t } = useTranslation();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border/50 bg-overlay/90 p-1 shadow-nf-md backdrop-blur-xl">
        {OPTIONS.map((option) => {
          const isActive = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              aria-pressed={isActive}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-200",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
