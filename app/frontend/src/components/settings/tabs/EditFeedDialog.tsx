import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateFeed, useUpdateFeedAI } from "@/hooks/useFeeds";
import { useUpdateFeedProxy, useProxySources } from "@/hooks/useProxySources";
import { TriStateControl } from "@/components/ui/tri-state-control";
import { ProxyEffectiveLine } from "@/components/settings/ProxyEffectiveLine";
import { cn } from "@/lib/utils";
import type { Feed, ProxyEffective, ProxyMode } from "@/types/api";

const SUMMARY_PROMPT_REMINDER_MAX_LENGTH = 2000;

interface EditFeedDialogProps {
  feed: Feed | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditFeedDialog({
  feed,
  open,
  onOpenChange,
}: EditFeedDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [summaryPromptReminder, setSummaryPromptReminder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autoTranslate, setAutoTranslate] = useState<boolean | null>(null);
  const [autoSummary, setAutoSummary] = useState<boolean | null>(null);
  const [readerMode, setReaderMode] = useState<boolean | null>(null);
  // 14 批：代理覆盖（三态）+ 保存后回显的实际生效结果
  const [proxyMode, setProxyMode] = useState<ProxyMode>("inherit");
  const [effective, setEffective] = useState<ProxyEffective | null>(null);
  const updateFeed = useUpdateFeed();
  const updateFeedAI = useUpdateFeedAI();
  const updateFeedProxy = useUpdateFeedProxy();
  // 一览里拿这一条的实际生效结果（打开弹窗就能看到「来自：文件夹『技术』」，不用先保存一次）
  const { data: proxySources } = useProxySources(Boolean(feed));
  const reminderLength = Array.from(summaryPromptReminder).length;
  const reminderTooLong = reminderLength > SUMMARY_PROMPT_REMINDER_MAX_LENGTH;

  useEffect(() => {
    if (feed) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setTitle(feed.title);
      setSummaryPromptReminder(feed.summaryPromptReminder ?? "");
      setAutoTranslate(feed.autoTranslate ?? null);
      setAutoSummary(feed.autoSummary ?? null);
      setReaderMode(feed.readerMode ?? null);
      setProxyMode(feed.proxyMode ?? "inherit");
      setEffective(null);
      setError(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [feed]);

  // 没保存过就以一览里的生效结果为准（保存后由 PATCH 的回显覆盖它）
  const shownEffective =
    effective ??
    proxySources?.feeds.find((item) => item.id === feed?.id)?.effective ??
    null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feed || !title.trim() || reminderTooLong) return;

    setError(null);
    try {
      await updateFeed.mutateAsync({
        id: feed.id,
        title: title.trim(),
        folderId: feed.folderId,
        summaryPromptReminder,
      });
      await updateFeedAI.mutateAsync({
        id: feed.id,
        autoTranslate,
        autoSummary,
        readerMode,
      });
      // 代理覆盖：只发 mode（config 不动 —— 「单独指定哪套」在设置→网络的「按来源覆盖」里管）
      const proxyResult = await updateFeedProxy.mutateAsync({
        id: feed.id,
        override: { mode: proxyMode },
      });
      setEffective(proxyResult.effective);
      onOpenChange(false);
    } catch {
      setError(t("feeds.update_failed"));
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0">
        <DialogHeader className="p-4">
          <DialogTitle>{t("feeds.edit_feed")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 px-4 pb-4">
          <div className="space-y-2">
            <label
              htmlFor="feed-title-input"
              className="text-sm font-medium text-foreground"
            >
              {t("feeds.feed_title")}
            </label>
            <input
              id="feed-title-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={cn(
                "w-full rounded-field border border-border bg-background px-3 py-2 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-primary/50",
                "placeholder:text-muted-foreground",
              )}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              {t("feeds.feed_url")}
              <span className="ml-2 text-xs">({t("feeds.url_readonly")})</span>
            </label>
            <div
              className={cn(
                "w-full truncate rounded-field border border-border bg-secondary/50 px-3 py-2 text-sm",
                "text-muted-foreground",
              )}
              title={feed?.url}
            >
              {feed?.url}
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="feed-summary-prompt-reminder"
                className="text-sm font-medium text-foreground"
              >
                {t("feeds.summary_prompt_reminder")}
              </label>
              <span
                className={cn(
                  "text-xs",
                  reminderTooLong
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {t("feeds.summary_prompt_reminder_count", {
                  count: reminderLength,
                  max: SUMMARY_PROMPT_REMINDER_MAX_LENGTH,
                })}
              </span>
            </div>
            <textarea
              id="feed-summary-prompt-reminder"
              value={summaryPromptReminder}
              onChange={(e) => setSummaryPromptReminder(e.target.value)}
              rows={6}
              className={cn(
                "min-h-28 w-full resize-y rounded-field border border-border bg-background px-3 py-2 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-primary/50",
                "placeholder:text-muted-foreground",
              )}
            />
            {reminderTooLong && (
              <p className="text-xs text-destructive">
                {t("feeds.summary_prompt_reminder_too_long", {
                  max: SUMMARY_PROMPT_REMINDER_MAX_LENGTH,
                })}
              </p>
            )}
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {/* 订阅级 AI 覆盖：单独成一块，不要和底部按钮挤在一行 */}
          <div className="space-y-1 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">
                {t("feeds.auto_translate")}
              </span>
              <TriStateControl
                value={autoTranslate}
                onChange={setAutoTranslate}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">
                {t("feeds.auto_summary")}
              </span>
              <TriStateControl value={autoSummary} onChange={setAutoSummary} />
            </div>
            {/* 正文打开方式：阅读模式（提取正文）/ 原文 */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">
                {t("feeds.reader_mode")}
              </span>
              <TriStateControl
                value={readerMode}
                onChange={setReaderMode}
                onLabel={t("feeds.reader_mode_on")}
                offLabel={t("feeds.reader_mode_off")}
              />
            </div>
            {/* 代理（14 批）：跟随上级（文件夹链 → 全局）/ 走代理 / 直连；下面直接显示这一条实际会怎么走 */}
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">
                  {t("proxy.override_label")}
                </span>
                <TriStateControl
                  value={proxyMode === "inherit" ? null : proxyMode === "proxy"}
                  onChange={(next) =>
                    setProxyMode(
                      next === null ? "inherit" : next ? "proxy" : "direct",
                    )
                  }
                  inheritLabel={t("proxy.follow_parent")}
                  onLabel={t("proxy.use_proxy")}
                  offLabel={t("proxy.direct")}
                />
              </div>
              <div className="flex justify-end">
                <ProxyEffectiveLine effective={shownEffective} />
              </div>
            </div>
          </div>

          {/* 底部按钮区：对齐 Nextflux 的 Modal.Footer（border-t + p-4） */}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={handleClose}
              className={cn(
                "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                "border border-border bg-background hover:bg-secondary",
              )}
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={
                !title.trim() || reminderTooLong || updateFeed.isPending
              }
              className={cn(
                "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {updateFeed.isPending ? t("settings.saving") : t("actions.save")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
