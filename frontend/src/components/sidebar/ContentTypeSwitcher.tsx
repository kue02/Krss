import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import { contentTypeMeta } from "@/lib/content-type-meta";
import { ViewIcon } from "@/components/automation/ViewIcon";
import { pluginViewKey, sortPluginViews } from "@/plugins/usePluginViews";
import type { PluginView } from "@/plugins/types";
import type { ContentType } from "@/types/api";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";

interface ContentTypeSwitcherProps {
  contentType: ContentType;
  counts: {
    article: number;
    picture: number;
    notification: number;
    social: number;
  };
  onSelect: (type: ContentType) => void;
  visibleContentTypes: ContentType[];
  /**
   * 56-28：插件注册的视图（`GET /api/plugins/views`，已停用的插件不在里面）。
   * 缺省空数组 —— 一个插件视图都没有时这一段整个不渲染，切换器与 56 批之前逐像素一致。
   */
  pluginViews?: PluginView[];
  /** 正在显示的插件视图 key（`插件id:视图id`），用于高亮 */
  activePluginView?: string | null;
  onSelectPluginView?: (key: string) => void;
}

/**
 * 内容类型切换 —— Nextflux 风格的分段胶囊：整条浅底容器，选中项浮起成卡片。
 *
 * 56-28：内置视图（文章/图片/通知/社交）在前，**插件视图**归到分隔线之后的
 * 「插件」分组（这一栏的行样式与侧栏「保存的筛选视图」同一套：`feedItemStyles`）。
 * 插件视图不在这个分段胶囊里，是因为它们的数量由用户装的插件决定，塞进 h-12 的一行里
 * 迟早会挤爆；分组之后内置那四个的位置也跟以前一模一样。
 */
export function ContentTypeSwitcher({
  contentType,
  counts,
  onSelect,
  visibleContentTypes,
  pluginViews = [],
  activePluginView = null,
  onSelectPluginView,
}: ContentTypeSwitcherProps) {
  const { t } = useTranslation();
  // 按 plugin 排序（同一插件的视图挨在一起）：调用方传乱序也不会跳来跳去
  const sortedPluginViews = useMemo(
    () => sortPluginViews(pluginViews),
    [pluginViews],
  );

  return (
    <div className="relative mb-1 mt-2 px-1">
      <div
        data-testid="view-switcher-builtin"
        className="flex h-12 items-center gap-1 rounded-xl bg-secondary/50 p-1"
      >
        {visibleContentTypes.map((type) => {
          const { icon: Icon, labelKey } = contentTypeMeta[type];
          const isActive = contentType === type;
          return (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className={cn(
                "relative flex h-full shrink-0 grow flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg transition-all duration-200",
                isActive
                  ? "bg-card text-foreground shadow-nf"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={t(labelKey)}
            >
              <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />
              <Icon
                className={cn("size-[1.125rem]", isActive && "text-primary")}
              />
              <div className="text-[0.625rem] font-medium leading-none tabular-nums">
                {counts[type]}
              </div>
            </button>
          );
        })}
      </div>

      {sortedPluginViews.length > 0 && (
        <div
          data-testid="view-switcher-plugin"
          className="mt-1.5 border-t border-border/60 pt-1.5"
        >
          <div className="px-2.5 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("sidebar.plugin_views")}
          </div>
          <div className="mt-0.5 space-y-px">
            {sortedPluginViews.map((view) => {
              const key = pluginViewKey(view);
              return (
                <button
                  key={key}
                  type="button"
                  data-testid="view-switcher-plugin-item"
                  data-plugin={view.plugin}
                  data-active={activePluginView === key}
                  className={cn(feedItemStyles, "pl-2.5")}
                  title={`${view.label} · ${view.plugin}`}
                  onClick={() => onSelectPluginView?.(key)}
                >
                  <span className={sidebarItemIconStyles}>
                    <ViewIcon icon={view.icon} />
                  </span>
                  <span className="grow truncate">{view.label}</span>
                  <span className="shrink-0 truncate text-[0.6875rem] text-muted-foreground/70">
                    {view.plugin}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
