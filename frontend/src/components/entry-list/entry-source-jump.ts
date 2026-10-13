import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * 52-4（用户第 4 条）：条目卡片上「订阅源名称 + 图标」的点击行为 —— 点了等于在第一栏点那个订阅。
 *
 * 四个视图（文章卡片 / 社交卡片 / 通知时间线 / 图片格子）的来源行长得不一样
 * （图标 20/18/16px、名字是否跑马灯、是否带 @handle），所以这里**不抽整行组件**，
 * 只抽「行为 + 提示文案 + 悬停态」这一份：调用方把 `sourceProps` 展开挂到自己已有的
 * 元素上（图标那一个 + 源名那一个 —— 两个都挂，点名字或点图标都跳）。
 * 与卡 B 同一口径：行为只有一份实现，样式各视图保留。
 *
 * 跳转走 `App` 透传下来的 `selectFeed`（和侧栏点击同一条路，所以第一栏高亮 / 列表 /
 * 滚动还原全是既有行为，不另开机制）；`stopPropagation` 是必须的 —— 否则会被卡片根的
 * 「选中这条条目」盖掉（同 24-2 那颗正文按钮的处理）。
 */
export interface EntrySourceJumpProps {
  /**
   * 挂到「图标」与「源名」元素上的 props；
   * 拿不到（这条没有 feed / 调用方没传回调）= null，来源行保持原样不可点。
   */
  sourceProps: {
    onClick: (event: React.MouseEvent) => void;
    title: string;
    className: string;
  } | null;
}

export function useEntrySourceJump(
  feed: { id: string; title: string } | undefined,
  onSelectFeedFromEntry?: (feedId: string) => void,
): EntrySourceJumpProps {
  const { t } = useTranslation();

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      // 点源名/图标 = 「去看这个订阅」，不是「选中这条条目」
      event.stopPropagation();
      event.preventDefault();
      if (feed) onSelectFeedFromEntry?.(feed.id);
    },
    [feed, onSelectFeedFromEntry],
  );

  return useMemo(() => {
    if (!feed || !onSelectFeedFromEntry) return { sourceProps: null };
    return {
      sourceProps: {
        onClick,
        title: t("entry.view_feed", { name: feed.title }),
        className:
          "cursor-pointer transition-colors duration-200 hover:text-foreground",
      },
    };
  }, [feed, onSelectFeedFromEntry, onClick, t]);
}
