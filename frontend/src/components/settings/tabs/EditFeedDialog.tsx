import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateFeed, useUpdateFeedAI } from "@/hooks/useFeeds";
import { copyToClipboard } from "@/stores/toast-store";
import { useUpdateFeedProxy, useProxySources } from "@/hooks/useProxySources";
import { TriStateControl } from "@/components/ui/tri-state-control";
import { ProxyEffectiveLine } from "@/components/settings/ProxyEffectiveLine";
import {
  GroupLabel,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { MCPSubscriptionWizard } from "@/components/settings/tabs/MCPSubscriptionWizard";
import { cn } from "@/lib/utils";
import { Copy } from "lucide-react";
import type { Feed, ProxyEffective, ProxyMode } from "@/types/api";
import {
  ApiError,
  getFeedMergePreview,
  mergeFeed,
  refreshFeeds,
  updateFeedUrl,
  type FeedMergePreview,
} from "@/api";

const SUMMARY_PROMPT_REMINDER_MAX_LENGTH = 2000;

/** 订阅地址只接受 http/https 且要有主机名（与后端 UpdateURL 的校验口径一致）。 */
function isValidFeedUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

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
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 改地址撞车时先挂住另一侧订阅，弹内联确认合并（不再嵌一层弹窗，免得 z-index 打架）
  const [mergePreview, setMergePreview] = useState<FeedMergePreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState<boolean | null>(null);
  const [autoSummary, setAutoSummary] = useState<boolean | null>(null);
  const [readerMode, setReaderMode] = useState<boolean | null>(null);
  // 14 批：代理覆盖（三态）+ 保存后回显的实际生效结果
  const [proxyMode, setProxyMode] = useState<ProxyMode>("inherit");
  const [effective, setEffective] = useState<ProxyEffective | null>(null);
  const updateFeed = useUpdateFeed();
  const updateFeedAI = useUpdateFeedAI();
  const updateFeedProxy = useUpdateFeedProxy();
  const queryClient = useQueryClient();
  // 16-14：MCP 订阅的取数配置走向导编辑模式（AI 栏不另起入口）
  const [mcpWizardOpen, setMcpWizardOpen] = useState(false);
  const isMCPFeed = feed?.sourceType === "mcp";
  // 一览里拿这一条的实际生效结果（打开弹窗就能看到「来自：文件夹『技术』」，不用先保存一次）
  const { data: proxySources } = useProxySources(Boolean(feed));
  const reminderLength = Array.from(summaryPromptReminder).length;
  const reminderTooLong = reminderLength > SUMMARY_PROMPT_REMINDER_MAX_LENGTH;

  useEffect(() => {
    if (feed) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setTitle(feed.title);
      setSummaryPromptReminder(feed.summaryPromptReminder ?? "");
      setUrl(feed.url);
      setAutoTranslate(feed.autoTranslate ?? null);
      setAutoSummary(feed.autoSummary ?? null);
      setReaderMode(feed.readerMode ?? null);
      setProxyMode(feed.proxyMode ?? "inherit");
      setEffective(null);
      setError(null);
      setMergePreview(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [feed]);

  // 没保存过就以一览里的生效结果为准（保存后由 PATCH 的回显覆盖它）
  const shownEffective =
    effective ??
    proxySources?.feeds.find((item) => item.id === feed?.id)?.effective ??
    null;

  // 52-3：名称清空 = 恢复默认名称（后端重新抓一次取 feed 标题，抓不到退可读域名名）。
  // 原先这里直接 `!title.trim()` 拦死，清空后保存按钮点不动。
  const isResetToDefault = open && title.trim() === "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feed || reminderTooLong || submitting) return;

    setError(null);
    const trimmedUrl = url.trim();
    const urlChanged = trimmedUrl !== feed.url;
    if (urlChanged && !isValidFeedUrl(trimmedUrl)) {
      setError(t("feeds.url_invalid"));
      return;
    }

    setSubmitting(true);
    try {
      // 改地址前先探一次：撞到别的订阅就先挂起，走内联「确认合并」
      if (urlChanged) {
        let target: FeedMergePreview | null = null;
        try {
          target = await getFeedMergePreview(feed.id, trimmedUrl);
        } catch {
          // 探测失败不拦，后端 PATCH 还有 409 兜底
          target = null;
        }
        if (target?.target) {
          setMergePreview(target);
          return;
        }
      }

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

      // 地址有变：PATCH 新地址 → 立刻用新地址刷新一次（旧文章按 feed_id 关联，不动）
      if (urlChanged) {
        await updateFeedUrl(feed.id, trimmedUrl);
        void refreshFeeds([feed.id]);
        void queryClient.invalidateQueries({ queryKey: ["feeds"] });
        void queryClient.invalidateQueries({ queryKey: ["entries"] });
        void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t("feeds.url_conflict_hint"));
      } else {
        setError(t("feeds.update_failed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 确认合并：把当前订阅并进撞车的那个订阅（保留目标，条目/星标一起挪过去）
  const handleConfirmMerge = async () => {
    if (!feed || !mergePreview?.target) return;
    setIsMerging(true);
    setError(null);
    try {
      await mergeFeed(feed.id, mergePreview.target.id);
      void refreshFeeds([mergePreview.target.id]);
      void queryClient.invalidateQueries({ queryKey: ["feeds"] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      setMergePreview(null);
      onOpenChange(false);
    } catch {
      setError(t("feeds.update_failed"));
    } finally {
      setIsMerging(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0">
        <DialogHeader className="p-4">
          <DialogTitle>{t("feeds.edit_feed")}</DialogTitle>
        </DialogHeader>
        {mergePreview?.target ? (
          <div className="space-y-4 px-4 pb-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">
                {t("feeds.url_conflict_title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("feeds.url_conflict_body", {
                  target: mergePreview.target.title,
                  targetCount: mergePreview.target.entries,
                  source: mergePreview.source.title,
                  sourceCount: mergePreview.source.entries,
                })}
              </p>
            </div>
            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => {
                  setMergePreview(null);
                  setError(null);
                }}
                className={cn(
                  "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                  "border border-border bg-background hover:bg-secondary",
                )}
              >
                {t("actions.cancel")}
              </button>
              <button
                type="button"
                onClick={handleConfirmMerge}
                disabled={isMerging}
                className={cn(
                  "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {isMerging ? t("settings.saving") : t("feeds.url_merge_confirm")}
              </button>
            </div>
          </div>
        ) : (
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
              placeholder={feed?.title}
              className={cn(
                "w-full rounded-field border border-border bg-background px-3 py-2 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-primary/50",
                "placeholder:text-muted-foreground",
              )}
              autoFocus
            />
            {/* 52-3：清空名称 = 存成默认名称（后端重抓取该源的 feed 标题） */}
            {isResetToDefault && (
              <p className="text-xs text-muted-foreground">
                {t("feeds.title_reset_hint")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label
              htmlFor="feed-url-input"
              className="text-sm font-medium text-foreground"
            >
              {t("feeds.feed_url")}
            </label>
            {/* 52-3：URL 可复制；订阅地址可编辑（长地址用单行输入框，聚焦后左右滚动查看） */}
            <div className="flex items-center gap-2">
              <input
                id="feed-url-input"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                title={url}
                placeholder={feed?.url}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                className={cn(
                  "min-w-0 flex-1 rounded-field border border-border bg-background px-3 py-2 text-sm",
                  "whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-primary/50",
                  "placeholder:text-muted-foreground",
                )}
              />
              {url.trim() && (
                <button
                  type="button"
                  onClick={() =>
                    void copyToClipboard(
                      url.trim(),
                      t("actions.copied_feed_url"),
                      t("actions.copy_failed"),
                    )
                  }
                  title={t("actions.copy_feed_url")}
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)]",
                    "border border-border bg-background text-muted-foreground",
                    "transition-colors hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Copy className="size-4" />
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("feeds.url_change_hint")}
            </p>
          </div>
          {/* 16-14：MCP 订阅的取数配置入口（连接/工具 + 编辑按钮，进向导编辑模式） */}
          {isMCPFeed && (
            <div className="space-y-2 rounded-field border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">
                  {t("feeds.mcp_config_title")}
                </span>
                <button
                  type="button"
                  onClick={() => setMcpWizardOpen(true)}
                  className={cn(
                    "rounded-[var(--radius)] px-3 py-1.5 text-xs font-medium transition-colors",
                    "border border-border bg-background hover:bg-secondary",
                  )}
                >
                  {t("feeds.mcp_config_edit")}
                </button>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {feed?.mcpConfig
                  ? t("feeds.mcp_config_summary", {
                      target:
                        feed.mcpConfig.kind === "tool"
                          ? (feed.mcpConfig.toolName ?? "")
                          : (feed.mcpConfig.resourceUri ?? ""),
                    })
                  : null}
              </div>
            </div>
          )}
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
          {/* 订阅级 AI / 代理覆盖：单独成一块，不要和底部按钮挤在一行 */}
          <div className="border-t border-border/60 pt-1">
            <GroupLabel>{t("feeds.overrides_group")}</GroupLabel>
            <div className="divide-y divide-border/50">
              <SettingRow label={t("feeds.auto_translate")}>
                <TriStateControl
                  value={autoTranslate}
                  onChange={(v) => setAutoTranslate(v === "smart" ? null : v)}
                />
              </SettingRow>
              <SettingRow label={t("feeds.auto_summary")}>
                <TriStateControl
                  value={autoSummary}
                  onChange={(v) => setAutoSummary(v === "smart" ? null : v)}
                />
              </SettingRow>
              {/* 正文打开方式：阅读模式（提取正文）/ 原文 */}
              <SettingRow label={t("feeds.reader_mode")}>
                <TriStateControl
                  value={readerMode}
                  onChange={(v) => setReaderMode(v === "smart" ? null : v)}
                  onLabel={t("feeds.reader_mode_on")}
                  offLabel={t("feeds.reader_mode_off")}
                />
              </SettingRow>
              {/* 代理（14 批）：跟随上级（文件夹链 → 全局）/ 走代理 / 直连；下面直接显示这一条实际会怎么走 */}
              <SettingRow label={t("proxy.override_label")}>
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
              </SettingRow>
            </div>
            <div className="flex justify-end px-1 pb-1 pt-1">
              <ProxyEffectiveLine effective={shownEffective} />
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
              disabled={reminderTooLong || submitting}
              className={cn(
                "rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {submitting ? t("settings.saving") : t("actions.save")}
            </button>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
    {isMCPFeed && (
      <MCPSubscriptionWizard
        open={mcpWizardOpen}
        onOpenChange={setMcpWizardOpen}
        servers={[]}
        editFeed={feed}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ["feeds"] });
        }}
      />
    )}
    </>
  );
}
