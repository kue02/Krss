import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { parseRoute, buildPath } from "@/lib/router";
import type { ContentType } from "@/types/api";

export type SelectionType =
  | { type: "all" }
  | { type: "feed"; feedId: string }
  | { type: "folder"; folderId: string }
  // viewOnly = 只显示当前内容类型（视图）下的星标条目
  | { type: "starred"; viewOnly?: boolean };

interface NavigateOptions {
  replace?: boolean;
}

interface UseSelectionReturn {
  selection: SelectionType;
  selectAll: (contentType?: ContentType, options?: NavigateOptions) => void;
  selectFeed: (
    feedId: string,
    options?: NavigateOptions,
    contentType?: ContentType,
  ) => void;
  selectFolder: (folderId: string, options?: NavigateOptions) => void;
  selectStarred: (options?: NavigateOptions, viewOnly?: boolean) => void;
  /** 中栏底部筛选胶囊：一次导航切换 全部 / 未读 / 星标 */
  selectFilter: (
    filter: "all" | "unread" | "starred",
    options?: NavigateOptions,
  ) => void;
  selectedEntryId: string | null;
  selectEntry: (entryId: string | null, options?: NavigateOptions) => void;
  unreadOnly: boolean;
  toggleUnreadOnly: () => void;
  contentType: ContentType;
  setContentType: (contentType: ContentType) => void;
}

export function useSelection(): UseSelectionReturn {
  const [location, navigate] = useLocation();
  const search = useSearch();

  const routeState = useMemo(
    () => parseRoute(location, search),
    [location, search],
  );

  const selectAll = useCallback(
    (contentType?: ContentType, options?: NavigateOptions) => {
      navigate(
        buildPath(
          { type: "all" },
          null,
          routeState.unreadOnly,
          contentType ?? routeState.contentType,
        ),
        options,
      );
    },
    [navigate, routeState.unreadOnly, routeState.contentType],
  );

  const selectFeed = useCallback(
    (feedId: string, options?: NavigateOptions, contentType?: ContentType) => {
      navigate(
        buildPath(
          { type: "feed", feedId },
          null,
          routeState.unreadOnly,
          // 24-3：默认跟当前 ?type=；搜索跳订阅时调用方传目标订阅实际的类型，
          // 否则目标订阅不在当前类型下就是一片空。
          contentType ?? routeState.contentType,
        ),
        options,
      );
    },
    [navigate, routeState.unreadOnly, routeState.contentType],
  );

  const selectFolder = useCallback(
    (folderId: string, options?: NavigateOptions) => {
      navigate(
        buildPath(
          { type: "folder", folderId },
          null,
          routeState.unreadOnly,
          routeState.contentType,
        ),
        options,
      );
    },
    [navigate, routeState.unreadOnly, routeState.contentType],
  );

  const selectStarred = useCallback(
    /**
     * viewOnly = 「只显示当前视图的星标」那一档。
     *
     * 20-2（用户 2026-09-18：星标入口收敛 + 默认选中）：**缺省就是 true** ——
     * 从侧栏「星标」进来看到的是当前内容类型下的星标；要看全部星标，
     * 在第二栏列表头把那个图标按钮关掉（传 false）。
     */
    (options?: NavigateOptions, viewOnly = true) => {
      navigate(
        buildPath(
          { type: "starred", viewOnly },
          null,
          routeState.unreadOnly,
          routeState.contentType,
        ),
        options,
      );
    },
    [navigate, routeState.unreadOnly, routeState.contentType],
  );

  /**
   * 中栏底部筛选胶囊用：在 全部 / 未读 / 星标 三者间一次导航切换。
   * 不要在调用方叠加 selectAll + toggleUnreadOnly —— 两次导航都基于旧 routeState，
   * 后者会覆盖前者（表现为「点了全部却还在星标页」）。
   *
   * 24-2：未读 / 全部只翻 `unreadOnly`，当前订阅 / 文件夹原样保留；
   * 星标维持跳全局（viewOnly 按 20-2 的默认档）。
   */
  const selectFilter = useCallback(
    (filter: "all" | "unread" | "starred", options?: NavigateOptions) => {
      if (filter === "starred") {
        navigate(
          buildPath(
            {
              type: "starred",
              // 20-2：进入星标视图默认「只当前视图」（已在星标里则保持当前档位）
              viewOnly:
                routeState.selection.type === "starred"
                  ? routeState.selection.viewOnly
                  : true,
            },
            null,
            // 星标维持旧语义：跳全局星标、不带 ?unread（24-2 只改未读/全部两档）
            false,
            routeState.contentType,
          ),
          options,
        );
        return;
      }
      navigate(
        buildPath(
          routeState.selection,
          null,
          filter === "unread",
          routeState.contentType,
        ),
        options,
      );
    },
    [
      navigate,
      routeState.contentType,
      routeState.selection,
    ],
  );

  const selectEntry = useCallback(
    (entryId: string | null, options?: NavigateOptions) => {
      navigate(
        buildPath(
          routeState.selection,
          entryId,
          routeState.unreadOnly,
          routeState.contentType,
        ),
        options,
      );
    },
    [
      navigate,
      routeState.selection,
      routeState.unreadOnly,
      routeState.contentType,
    ],
  );

  const toggleUnreadOnly = useCallback(() => {
    navigate(
      buildPath(
        routeState.selection,
        routeState.entryId,
        !routeState.unreadOnly,
        routeState.contentType,
      ),
      { replace: true },
    );
  }, [
    navigate,
    routeState.selection,
    routeState.entryId,
    routeState.unreadOnly,
    routeState.contentType,
  ]);

  const setContentType = useCallback(
    (contentType: ContentType) => {
      navigate(
        buildPath(
          routeState.selection,
          routeState.entryId,
          routeState.unreadOnly,
          contentType,
        ),
      );
    },
    [navigate, routeState.selection, routeState.entryId, routeState.unreadOnly],
  );

  return {
    selectFilter,
    selection: routeState.selection,
    selectAll,
    selectFeed,
    selectFolder,
    selectStarred,
    selectedEntryId: routeState.entryId,
    selectEntry,
    unreadOnly: routeState.unreadOnly,
    toggleUnreadOnly,
    contentType: routeState.contentType,
    setContentType,
  };
}

export function selectionToParams(
  selection: SelectionType,
  contentType?: ContentType,
): {
  feedId?: string;
  folderId?: string;
  starredOnly?: boolean;
  contentType?: ContentType;
} {
  const base: {
    feedId?: string;
    folderId?: string;
    starredOnly?: boolean;
    contentType?: ContentType;
  } = {};

  // 只有 all 用内容类型来筛（feed/folder 自带类型）；
  // 例外：星标视图里那一档「只显示当前视图」也要按内容类型筛（用户 2026-09-17 要求）
  if (
    contentType &&
    (selection.type === "all" ||
      (selection.type === "starred" && selection.viewOnly))
  ) {
    base.contentType = contentType;
  }

  switch (selection.type) {
    case "all":
      return base;
    case "feed":
      return { ...base, feedId: selection.feedId };
    case "folder":
      return { ...base, folderId: selection.folderId };
    case "starred":
      return { ...base, starredOnly: true };
  }
}
