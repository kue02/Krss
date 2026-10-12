import type { SelectionType } from "@/hooks/useSelection";
import type { ContentType } from "@/types/api";

export interface RouteState {
  selection: SelectionType;
  entryId: string | null;
  unreadOnly: boolean;
  contentType: ContentType;
}

function parseContentType(value: string | null): ContentType {
  if (value === "picture" || value === "notification" || value === "social") {
    return value;
  }
  return "article";
}

/**
 * Parse URL pathname and search params into route state
 *
 * `defaultUnreadOnly` = 地址栏没带 `?unread` 时用哪一档。
 * 47-1（用户 2026-10-12）：默认改成「只显示未读」，且这一档由调用方从
 * 界面设置（`useUISettingKey("unreadOnly")`）传进来 —— 用户手动关掉后
 * 下次打开仍是他上次那档（toggling 会写回设置）。
 */
export function parseRoute(
  pathname: string,
  search: string,
  defaultUnreadOnly = true,
): RouteState {
  const params = new URLSearchParams(search);
  const unreadParam = params.get("unread");
  const unreadOnly =
    unreadParam === "true"
      ? true
      : unreadParam === "false"
        ? false
        : defaultUnreadOnly;
  const contentType = parseContentType(params.get("type"));

  // Remove leading slash and split
  const segments = pathname.replace(/^\//, "").split("/").filter(Boolean);

  // Default: /all or /
  if (segments.length === 0 || segments[0] === "all") {
    return {
      selection: { type: "all" },
      entryId: segments[1] || null,
      unreadOnly,
      contentType,
    };
  }

  // /feed/:feedId/:entryId?
  if (segments[0] === "feed" && segments[1]) {
    return {
      selection: { type: "feed", feedId: segments[1] },
      entryId: segments[2] || null,
      unreadOnly,
      contentType,
    };
  }

  // /folder/:folderId/:entryId?
  if (segments[0] === "folder" && segments[1]) {
    return {
      selection: { type: "folder", folderId: segments[1] },
      entryId: segments[2] || null,
      unreadOnly,
      contentType,
    };
  }

  // /starred/:entryId?  —— 20-2 起「只显示当前视图（内容类型）的星标」是**默认档**：
  // 没有 ?scope 或 scope=view 都算它；只有显式 ?scope=all 才是「全部星标」。
  if (segments[0] === "starred") {
    return {
      selection: {
        type: "starred",
        viewOnly: params.get("scope") !== "all",
      },
      entryId: segments[1] || null,
      unreadOnly,
      contentType,
    };
  }

  // Fallback to all
  return {
    selection: { type: "all" },
    entryId: null,
    unreadOnly,
    contentType,
  };
}

/**
 * Build URL path from route state
 */
export function buildPath(
  selection: SelectionType,
  entryId?: string | null,
  unreadOnly?: boolean,
  contentType?: ContentType,
): string {
  let path: string;

  switch (selection.type) {
    case "all":
      path = entryId ? `/all/${entryId}` : "/all";
      break;
    case "feed":
      path = entryId
        ? `/feed/${selection.feedId}/${entryId}`
        : `/feed/${selection.feedId}`;
      break;
    case "folder":
      path = entryId
        ? `/folder/${selection.folderId}/${entryId}`
        : `/folder/${selection.folderId}`;
      break;
    case "starred":
      path = entryId ? `/starred/${entryId}` : "/starred";
      break;
  }

  const params = new URLSearchParams();
  if (typeof unreadOnly === "boolean") {
    // 47-1（用户 2026-10-12）：以前只在 true 时写参，「关」这一档靠缺席表达 ——
    // 但缺席现在要按「记住的那一档」兜底，所以关也得显式写出来，
    // 否则「点全部」会立刻被兜底值翻回未读（同一屏内自相矛盾）。
    params.set("unread", unreadOnly ? "true" : "false");
  }
  if (selection.type === "starred") {
    // 20-2：默认档就是「只当前视图」，显式写出来（关掉时写 all）——
    // 这样地址栏一眼能看出当前是哪一档，旧的 /starred（无 scope）仍按默认档解析。
    params.set("scope", selection.viewOnly === false ? "all" : "view");
  }
  if (contentType) {
    params.set("type", contentType);
  }
  const queryString = params.toString();
  if (queryString) {
    path += "?" + queryString;
  }

  return path;
}

/**
 * Check if current path is add-feed page
 */
export function isAddFeedPath(pathname: string): boolean {
  return pathname === "/add-feed";
}
