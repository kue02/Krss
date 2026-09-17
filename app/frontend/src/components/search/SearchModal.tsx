import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { searchEntries } from "@/api";
import { useFeeds } from "@/hooks/useFeeds";
import { useMarkAsRead } from "@/hooks/useEntries";
import { useSelection } from "@/hooks/useSelection";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SearchIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/date-utils";
import type { Entry } from "@/types/api";

interface SearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SearchTab = "articles" | "feeds";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * 搜索弹窗（对齐 NextFlux 的 SearchModal）：
 * 700×500 的玻璃面板、顶部搜索框、结果列表（↑↓ 切换 / Enter 打开 / Esc 关闭）、
 * 底部「文章 / 订阅」两档 + 键位提示。
 *
 * 文章走后端 /entries/search（标题/正文/作者/链接子串匹配，中文也能搜词中），
 * 订阅在本地过滤（NextFlux 也是本地过滤名称与地址）。
 */
export function SearchModal({ open, onOpenChange }: SearchModalProps) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const { selectEntry } = useSelection();
  const { data: feeds } = useFeeds();
  const { mutate: markAsRead } = useMarkAsRead();

  const [tab, setTab] = useState<SearchTab>("articles");
  const [keyword, setKeyword] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isComposing, setIsComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = keyword.trim();

  // 关闭时清空，避免下次打开还挂着上次的结果
  useEffect(() => {
    if (open) return;
    setKeyword("");
    setEntries([]);
    setSelectedIndex(-1);
    setTab("articles");
  }, [open]);

  // 文章搜索（防抖；中文输入法组词期间不发请求）
  useEffect(() => {
    if (!open || tab !== "articles") return;
    if (!trimmed) {
      setEntries([]);
      setSearching(false);
      return;
    }
    if (isComposing) return;

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchEntries(trimmed)
        .then((res) => {
          if (cancelled) return;
          setEntries(res.entries);
          setSelectedIndex(res.entries.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, tab, trimmed, isComposing]);

  // 订阅：本地按名称/地址过滤（与 NextFlux 一致）
  const feedResults = useMemo(() => {
    if (tab !== "feeds") return [];
    const list = (feeds ?? []).filter((feed) => !!feed.id);
    if (!trimmed) return list;
    const needle = trimmed.toLowerCase();
    return list.filter((feed) =>
      [feed.title, feed.url]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [tab, feeds, trimmed]);

  const resultCount = tab === "articles" ? entries.length : feedResults.length;

  const handleSelect = useCallback(
    (index: number) => {
      if (tab === "articles") {
        const entry = entries[index];
        if (!entry) return;
        onOpenChange(false);
        if (!entry.read) markAsRead({ id: entry.id, read: true });
        selectEntry(entry.id);
        return;
      }

      const feed = feedResults[index];
      if (!feed) return;
      onOpenChange(false);
      navigate(`/feed/${feed.id}`);
    },
    [
      tab,
      entries,
      feedResults,
      markAsRead,
      selectEntry,
      navigate,
      onOpenChange,
    ],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev < resultCount - 1 ? prev + 1 : prev));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      handleSelect(selectedIndex);
    }
  };

  const showEmpty = !searching && resultCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "flex h-[500px] max-h-[80vh] w-[700px] max-w-[92vw] flex-col gap-0 overflow-hidden p-0",
          // NextFlux 真机实测：700×500、bg-overlay/90 + blur(16px)、19.2px 圆角、1px 边框、大阴影、输入 18px
          "rounded-[19.2px] border border-border bg-overlay/90 backdrop-blur-lg shadow-2xl",
        )}
      >
        <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>

        {/* 头部：搜索框 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
          <SearchIcon className="size-5 shrink-0 text-muted-foreground opacity-60" />
          <input
            ref={inputRef}
            autoFocus
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              tab === "articles"
                ? t("search.articles_placeholder")
                : t("search.feeds_placeholder")
            }
            className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* 结果 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {showEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/60">
              <SearchIcon className="size-12" />
              <span className="text-sm">
                {trimmed ? t("search.no_results") : t("search.hint")}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {tab === "articles"
                ? entries.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => handleSelect(index)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150",
                        index === selectedIndex ? "bg-item-hover" : "hover:bg-item-hover/60",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {entry.title || entry.url || entry.id}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {entry.publishedAt
                          ? formatRelativeTime(entry.publishedAt, t)
                          : ""}
                      </span>
                    </button>
                  ))
                : feedResults.map((feed, index) => (
                    <button
                      key={feed.id}
                      type="button"
                      onClick={() => handleSelect(index)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150",
                        index === selectedIndex ? "bg-item-hover" : "hover:bg-item-hover/60",
                      )}
                    >
                      {/* 只显示名称：订阅地址里带着 RSSHub 的 key，没必要摊在搜索结果里 */}
                      <span className="min-w-0 flex-1 truncate">
                        {feed.title}
                      </span>
                    </button>
                  ))}
            </div>
          )}
        </div>

        {/* 底部：范围切换 + 键位提示 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <div className="flex items-center gap-1">
            {(
              [
                ["articles", t("search.tab_articles")],
                ["feeds", t("search.tab_feeds")],
              ] as [SearchTab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTab(value);
                  setSelectedIndex(-1);
                  inputRef.current?.focus();
                }}
                className={cn(
                  "rounded-lg px-3 py-1 text-xs transition-colors duration-200",
                  tab === value
                    ? "bg-item-hover text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono">
              ↑
            </span>
            <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono">
              ↓
            </span>
            <span>{t("search.switch")}</span>
            <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono">
              ↵
            </span>
            <span>{t("search.open")}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
