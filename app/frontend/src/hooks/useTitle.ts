import { useEffect, useRef } from "react";
import type { SelectionType } from "./useSelection";
import type { ContentType, Feed, Folder } from "@/types/api";

interface BuildTitleParams {
  selection: SelectionType;
  contentType: ContentType;
  entryTitle?: string | null;
  feedsMap: Map<string, Feed>;
  foldersMap: Map<string, Folder>;
  t: (key: string) => string;
}

/**
 * Build page title based on current route state
 */
export function buildTitle({
  selection,
  contentType,
  entryTitle,
  feedsMap,
  foldersMap,
  t,
}: BuildTitleParams): string {
  // Entry title has highest priority
  if (entryTitle) {
    return `${entryTitle} | krss`;
  }

  // Selection-based titles
  switch (selection.type) {
    case "all":
      return `${t(`content_type.${contentType}`)} | krss`;
    case "feed": {
      const feed = feedsMap.get(selection.feedId);
      return feed ? `${feed.title} | krss` : "krss";
    }
    case "folder": {
      const folder = foldersMap.get(selection.folderId);
      return folder ? `${folder.name} | krss` : "krss";
    }
    case "starred":
      return `${t("entry_list.starred")} | krss`;
    default:
      return "krss";
  }
}

/**
 * Update document title dynamically
 */
export function useTitle(title: string) {
  const originalTitle = useRef(document.title);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // Restore original title on unmount
  useEffect(() => {
    const initialTitle = originalTitle.current;
    return () => {
      document.title = initialTitle;
    };
  }, []);
}
