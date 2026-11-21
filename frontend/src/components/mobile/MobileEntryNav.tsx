import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSelection } from "@/hooks/useSelection";
import type { Entry, EntryListResponse } from "@/types/api";

interface MobileEntryNavProps {
  entryId: string;
}

/**
 * 详情页底部「上一条 / 下一条」胶囊。
 *
 * 直接读当前列表的 react-query 缓存，不另发请求；按包含当前条目的最长一份
 * `["entries", …]` 列表计算前后项。点前后项沿用 `selectEntry`，与列表打开同一条路径。
 */
export function MobileEntryNav({ entryId }: MobileEntryNavProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectEntry } = useSelection();

  const nav = useMemo(() => {
    const queries = queryClient.getQueryCache().findAll({ queryKey: ["entries"] });
    let best: Entry[] = [];

    for (const query of queries) {
      const data = query.state.data as { pages?: EntryListResponse[] } | undefined;
      const entries = data?.pages?.flatMap((page) => page.entries ?? []) ?? [];
      if (entries.length > best.length && entries.some((item) => item.id === entryId)) {
        best = entries;
      }
    }

    const index = best.findIndex((item) => item.id === entryId);
    if (index < 0) return null;
    return {
      previous: index > 0 ? best[index - 1] : undefined,
      next: index < best.length - 1 ? best[index + 1] : undefined,
      position: index + 1,
      total: best.length,
    };
  }, [entryId, queryClient]);

  if (!nav) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex h-11 items-center gap-0.5 rounded-full border border-border/60 bg-overlay/90 p-0.5 shadow-nf-md backdrop-blur-xl">
        <button
          type="button"
          disabled={!nav.previous}
          onClick={() => nav.previous && selectEntry(nav.previous.id)}
          aria-label={t("entry.previous")}
          className="flex size-10 items-center justify-center rounded-full text-foreground active:bg-item-hover disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-14 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
          {nav.position} / {nav.total}
        </span>
        <button
          type="button"
          disabled={!nav.next}
          onClick={() => nav.next && selectEntry(nav.next.id)}
          aria-label={t("entry.next")}
          className="flex size-10 items-center justify-center rounded-full text-foreground active:bg-item-hover disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
