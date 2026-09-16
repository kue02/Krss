import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useAddFeed, type SubscribeOptions } from "@/hooks/useAddFeed";
import { useFolders } from "@/hooks/useFolders";
import { ViewPreviewMock } from "./ViewPreviewMock";
import {
  FileTextIcon,
  ImageIcon,
  BellIcon,
  SocialIcon,
} from "@/components/ui/icons";
import { BackIcon } from "@/components/ui/icons";
import { FeedUrlForm } from "./FeedUrlForm";
import { FeedPreviewCard } from "./FeedPreviewCard";
import type { ContentType } from "@/types/api";

interface AddFeedPageProps {
  onClose: () => void;
  onFeedAdded?: (feedUrl: string) => void;
  contentType?: ContentType;
}

export type { FeedPreview } from "@/types/api";
export type { SubscribeOptions } from "@/hooks/useAddFeed";

export function AddFeedPage({
  onClose,
  onFeedAdded,
  contentType = "article",
}: AddFeedPageProps) {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = useState<ContentType>(contentType);
  const { feedPreview, isLoading, error, rewrittenFrom, discoverFeed, subscribeFeed } =
    useAddFeed(selectedType);

  const typeOptions = useMemo(
    () => [
      { value: "article" as ContentType, icon: FileTextIcon },
      { value: "picture" as ContentType, icon: ImageIcon },
      { value: "notification" as ContentType, icon: BellIcon },
      { value: "social" as ContentType, icon: SocialIcon },
    ],
    [],
  );
  const { data: folders = [] } = useFolders();

  const handleSubscribe = useCallback(
    async (feedUrl: string, options: SubscribeOptions) => {
      const success = await subscribeFeed(feedUrl, options);
      if (success) {
        onFeedAdded?.(feedUrl);
        onClose();
      }
    },
    [subscribeFeed, onFeedAdded, onClose],
  );

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Back button - top left */}
      <button
        type="button"
        onClick={onClose}
        className={cn(
          "absolute left-4 top-4 z-10",
          "inline-flex items-center gap-1.5",
          "rounded-lg px-3 py-1.5",
          "text-sm text-muted-foreground",
          "hover:bg-accent/50 hover:text-foreground",
          "transition-colors duration-200",
        )}
      >
        <BackIcon className="size-4" />
        <span>{t("add_feed.back")}</span>
      </button>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-6 py-16">
          {/* Hero Section */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
              <svg
                className="size-8 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M6 5c7.18 0 13 5.82 13 13M6 11a7 7 0 017 7m-6 0a1 1 0 11-2 0 1 1 0 012 0z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-semibold">
              {t("add_feed.add_rss_feed")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("add_feed.feed_description")}
            </p>
          </div>

          {/* URL Form */}
          <FeedUrlForm onSubmit={discoverFeed} isLoading={isLoading} />

          {/* RSSHub 实例改写提示 */}
          {rewrittenFrom && (
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {t("settings.rsshub_rewritten_hint")}
            </p>
          )}

          {/* Error Message */}
          {error && (
            <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* 选择视图 + 效果小样（#8） */}
          {feedPreview && (
            <div className="mt-6 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {t("add_feed.choose_view")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {typeOptions.map((option) => {
                    const Icon = option.icon;
                    const isActive = option.value === selectedType;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSelectedType(option.value)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-200",
                          isActive
                            ? "border-primary bg-item-active text-foreground"
                            : "border-border text-muted-foreground hover:bg-item-hover hover:text-foreground",
                        )}
                      >
                        <Icon className="size-3.5" />
                        {t(`content_type.${option.value}`)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <ViewPreviewMock
                type={selectedType}
                sampleTitle={feedPreview.title}
              />
            </div>
          )}

          {/* Feed Preview */}
          {feedPreview && (
            <div className="mt-6">
              <FeedPreviewCard
                feed={feedPreview}
                folders={folders}
                contentType={selectedType}
                onSubscribe={handleSubscribe}
                isLoading={isLoading}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
