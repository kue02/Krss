import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Chip } from "@heroui/react";
import { X } from "lucide-react";
import { listEntries, searchEntries } from "@/api";
import { useFeeds } from "@/hooks/useFeeds";
import { EntryListItem } from "@/components/entry-list/EntryListItem";
import { NotificationTimeline } from "@/components/entry-list/NotificationTimeline";
import {
  DEFAULT_TIMELINE_COLLAPSE,
  DEFAULT_TIMELINE_GRANULARITY,
} from "@/lib/timeline-model";
import { ViewIcon } from "@/components/automation/ViewIcon";
import { cn } from "@/lib/utils";
import { SandboxFrame } from "./SandboxFrame";
import { pluginViewKey } from "./usePluginViews";
import type { PluginViewResolution } from "./usePluginViews";
import type { PluginView } from "./types";
import {
  pluginViewFetchPlan,
  resolvePluginViewLayout,
  shapeEntries,
} from "./view-plan";

/**
 * 插件视图的渲染（56-28）。
 *
 * 两种形态（后端 56-27 的 `kind`）：
 *   - `declarative`：插件只声明「取哪些条目」，界面用宿主现成的条目组件画（`EntryListItem` /
 *     现有时间线）。插件不自带界面也能出一个视图，配色与交互自动跟宿主一致。
 *   - `custom`：插件自带 HTML（56-24 的 `/ui/*` + 56-25 的沙箱 iframe），宿主只给一块画布。
 *
 * 两种都在**视图壳**里：顶部一条有视图名、「插件视图」徽标和退出按钮。
 * 插件自带界面一旦铺满主区域，用户就没路回列表了 —— 所以这道壳是硬要求。
 * 取数翻译（`query` → 接口参数 / `layout` → 版式）在 `./view-plan`，纯函数、单独可验。
 */

/** 每个视图每页取多少条（与列表的缺省页大小一致，见 useEntries.ts） */
const PAGE_SIZE = 50;

export type PluginViewPaneProps = {
  view: PluginView;
  /** 插件申请到的权限（转交给沙箱 bridge） */
  permissions?: readonly string[];
  /** 退出插件视图（回到内置视图） */
  onExit: () => void;
  /** 点条目：交回宿主（打开阅读器 = 离开插件视图），不传则行不可点开 */
  onSelectEntry?: (entryId: string) => void;
  /** 插件请求切视图 / 打开条目（沙箱 bridge 的 `plugin:navigate`） */
  onNavigate?: (target: { viewId?: string; entryId?: string }) => void;
};

export function PluginViewPane({
  view,
  permissions,
  onExit,
  onSelectEntry,
  onNavigate,
}: PluginViewPaneProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-plugin-view={pluginViewKey(view)}
    >
      {/* 视图壳：无论插件画什么，这一条都在 —— 用户随时能切走 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <ViewIcon icon={view.icon} />
        <span className="min-w-0 truncate text-sm font-semibold">
          {view.label}
        </span>
        <Chip
          size="sm"
          variant="tertiary"
          className="shrink-0 border border-border text-muted-foreground"
        >
          {t("plugins.plugin_view_badge")}
        </Chip>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 gap-1"
          onPress={onExit}
          aria-label={t("plugins.plugin_view_exit")}
        >
          <X className="size-4" />
          {t("plugins.plugin_view_exit")}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {view.kind === "custom" ? (
          <SandboxFrame
            pluginId={view.plugin}
            page={view.entry || "index.html"}
            title={view.label}
            permissions={permissions}
            view={{ id: view.id, title: view.label }}
            onNavigate={onNavigate}
          />
        ) : (
          <DeclarativePluginView view={view} onSelectEntry={onSelectEntry} />
        )}
      </div>
    </div>
  );
}

/**
 * 声明式视图：翻页走 `/api/entries` 的 offset/limit，同一个视图 id 一份缓存。
 *
 * 检索（`query.search`）是另一条接口（`/api/entries/search?q=`，不分页），
 * 所以两条钩子都挂着、用 `enabled` 二选一 —— 钩子不能条件调用。
 */
function DeclarativePluginView({
  view,
  onSelectEntry,
}: {
  view: PluginView;
  onSelectEntry?: (entryId: string) => void;
}) {
  const { t } = useTranslation();
  const plan = useMemo(() => pluginViewFetchPlan(view), [view]);
  const layout = resolvePluginViewLayout(view.layout);
  const search = plan.search ?? "";
  const key = pluginViewKey(view);

  const listQuery = useInfiniteQuery({
    queryKey: ["pluginViewEntries", key, plan.params],
    queryFn: ({ pageParam }) =>
      listEntries({ ...plan.params, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * PAGE_SIZE : undefined,
    enabled: !search,
  });

  const searchQuery = useQuery({
    queryKey: ["pluginViewSearch", key, search],
    queryFn: () => searchEntries(search, PAGE_SIZE),
    enabled: Boolean(search),
  });

  const { data: feeds = [] } = useFeeds();
  const feedsById = useMemo(
    () => new Map(feeds.map((feed) => [feed.id, feed])),
    [feeds],
  );

  const entries = useMemo(() => {
    const raw = search
      ? (searchQuery.data?.entries ?? [])
      : (listQuery.data?.pages.flatMap((page) => page.entries) ?? []);
    return shapeEntries(raw, plan);
  }, [search, searchQuery.data, listQuery.data, plan]);

  const isLoading = search ? searchQuery.isLoading : listQuery.isLoading;

  const handleSelect = useCallback(
    (entryId: string) => {
      onSelectEntry?.(entryId);
    },
    [onSelectEntry],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("entry.loading")}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("plugins.plugin_view_empty")}
      </div>
    );
  }

  if (layout === "timeline") {
    return (
      <div className="h-full overflow-y-auto px-3 py-2">
        <NotificationTimeline
          entries={entries}
          feeds={feedsById}
          selectedEntryId={null}
          onSelectEntry={handleSelect}
          granularity={DEFAULT_TIMELINE_GRANULARITY}
          collapse={DEFAULT_TIMELINE_COLLAPSE}
          autoTranslate={false}
          targetLanguage="zh-CN"
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      <div
        className={cn(
          layout === "grid"
            ? "grid gap-2 sm:grid-cols-2 2xl:grid-cols-3"
            : "space-y-1",
        )}
      >
        {entries.map((entry) => (
          <EntryListItem
            key={entry.id}
            entry={entry}
            feed={feedsById.get(entry.feedId)}
            isSelected={false}
            onClick={handleSelect}
          />
        ))}
      </div>
    </div>
  );
}

export type PluginViewOutletProps = {
  resolution: PluginViewResolution;
  /** 回落用的内置视图（也就是「文章」那一套列表）—— 认不出的 `?view=` 交给它 */
  fallback: React.ReactNode;
  permissions?: readonly string[];
  onExit: () => void;
  onSelectEntry?: (entryId: string) => void;
  onNavigate?: (target: { viewId?: string; entryId?: string }) => void;
};

/**
 * 主内容区的分流：插件视图 / 加载中 / 回落内置视图。
 *
 * 单独抽成一个组件，是为了让「回落」这条**没有插件也走得通**的路也能被测试，
 * 而不是散在 App 的几处 early return 里（那几处只有整页渲染才测得到）。
 */
export function PluginViewOutlet({
  resolution,
  fallback,
  permissions,
  onExit,
  onSelectEntry,
  onNavigate,
}: PluginViewOutletProps) {
  if (resolution.status === "resolved") {
    return (
      <PluginViewPane
        view={resolution.view}
        permissions={permissions}
        onExit={onExit}
        onSelectEntry={onSelectEntry}
        onNavigate={onNavigate}
      />
    );
  }
  if (resolution.status === "loading") {
    // 清单还在路上：先给一块空底，别先画内置列表再跳（会看见内容闪一下）
    return (
      <div
        className="h-full w-full bg-background"
        data-plugin-view-loading=""
      />
    );
  }
  return <>{fallback}</>;
}
