import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import { AlertDialog, Button } from "@heroui/react";
import {
  getFeedMergePreview,
  mergeFeed,
  updateFeedUrl,
  updateGeneralSettings,
  type FeedMergeSide,
} from "@/api";
import { useFeeds } from "@/hooks/useFeeds";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { rewriteRssHubUrl } from "@/lib/rsshub";
import { queryClient } from "@/lib/queryClient";
import { showToast } from "@/stores/toast-store";

interface PendingRewrite {
  feedId: string;
  title: string;
  from: string;
  to: string;
}

/** 换地址后与已有订阅撞成同一地址的那条：弹框要显示两边各有几条 */
interface MergeConflict extends PendingRewrite {
  source: FeedMergeSide;
  target: FeedMergeSide;
}

/**
 * RSSHub 适配：填自有实例地址（可带 ACCESS_KEY）。
 * - 之后添加订阅时，RSSHub 地址会自动换到该实例
 * - 「预览」列出会被改写的现有订阅，「应用」一次性换掉
 */
export function RSSHubSettings() {
  const { t } = useTranslation();
  const { data: generalSettings } = useGeneralSettings();
  const { data: feeds = [] } = useFeeds();
  const [baseUrl, setBaseUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [mergePlan, setMergePlan] = useState<{
    plain: PendingRewrite[];
    conflicts: MergeConflict[];
  } | null>(null);

  useEffect(() => {
    if (!generalSettings) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setBaseUrl(generalSettings.rsshubBaseUrl ?? "");
    setAccessKey(generalSettings.rsshubAccessKey ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [generalSettings]);

  const savedBaseUrl = generalSettings?.rsshubBaseUrl ?? "";
  const savedAccessKey = generalSettings?.rsshubAccessKey ?? "";
  const isDirty = baseUrl !== savedBaseUrl || accessKey !== savedAccessKey;
  // 12-7：把「这一页有未保存改动」登记给设置弹窗（切页/关闭时问一句）
  useSettingsDirty("rsshub", isDirty, t("settings.dirty_label_rsshub"), () => handleSave());

  const pending = useMemo<PendingRewrite[]>(() => {
    const target = baseUrl.trim();
    if (!target) return [];

    return feeds.flatMap((feed) => {
      const next = rewriteRssHubUrl(feed.url, target, accessKey);
      if (!next || next === feed.url) return [];
      return [{ feedId: feed.id, title: feed.title, from: feed.url, to: next }];
    });
  }, [accessKey, baseUrl, feeds]);

  const handleSave = useCallback(async () => {
    if (!generalSettings) return;

    setIsSaving(true);
    try {
      // 整体展开现有设置再覆盖本块字段：通用设置是整体 PUT，漏字段会把别人刚存的擦掉
      await updateGeneralSettings({
        ...generalSettings,
        rsshubBaseUrl: baseUrl.trim(),
        rsshubAccessKey: accessKey.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ["generalSettings"] });
      setShowPreview(false);
      showToast(t("settings.rsshub_saved"));
    } catch {
      showToast(t("settings.rsshub_save_failed"));
    } finally {
      setIsSaving(false);
    }
  }, [accessKey, baseUrl, generalSettings, t]);

  /** 真正执行：plain 直接换地址；conflicts 按用户拍板决定「合并」还是「跳过」 */
  const runRewrites = useCallback(
    async (
      plain: PendingRewrite[],
      conflicts: MergeConflict[],
      doMerge: boolean,
    ) => {
      setIsApplying(true);
      let changed = 0;
      let merged = 0;
      for (const item of plain) {
        try {
          await updateFeedUrl(item.feedId, item.to);
          changed += 1;
        } catch {
          // 单条失败不影响其余，最后统一汇报
        }
      }
      if (doMerge) {
        for (const conflict of conflicts) {
          try {
            await mergeFeed(conflict.feedId, conflict.target.id);
            merged += 1;
          } catch {
            // 同上：失败不吞掉其余，最后统一汇报
          }
        }
      }
      setIsApplying(false);
      setShowPreview(false);
      setMergePlan(null);
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      queryClient.invalidateQueries({ queryKey: ["entries"] });

      if (merged > 0) {
        showToast(t("settings.rsshub_merge_merged", { merged, changed }));
      } else if (changed === plain.length) {
        showToast(t("settings.rsshub_applied", { count: changed }));
      } else {
        showToast(
          t("settings.rsshub_applied_partial", {
            changed,
            total: plain.length,
          }),
        );
      }
    },
    [t],
  );

  const handleApply = useCallback(async () => {
    if (pending.length === 0) return;

    // 换地址前先探一遍：换过去之后地址是不是已经属于另一个订阅（RSSHub 换实例后两条订阅同源）。
    // 撞上了就交给用户拍板，不撞车直接改。
    setIsApplying(true);
    const conflicts: MergeConflict[] = [];
    const plain: PendingRewrite[] = [];
    for (const item of pending) {
      try {
        const preview = await getFeedMergePreview(item.feedId, item.to);
        if (preview.target) {
          conflicts.push({
            ...item,
            source: preview.source,
            target: preview.target,
          });
          continue;
        }
      } catch {
        // 探不动就按老路走：后端 PATCH 那边还有 409 兜底
      }
      plain.push(item);
    }
    setIsApplying(false);

    if (conflicts.length > 0) {
      setMergePlan({ plain, conflicts });
      return;
    }
    await runRewrites(plain, [], false);
  }, [pending, runRewrites]);

  return (
    <section className="space-y-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("settings.rsshub_label")}</div>
        <div className="text-xs text-muted-foreground">
          {t("settings.rsshub_description")}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://rsshub.example.com"
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent"
        />
        <input
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
          placeholder={t("settings.rsshub_access_key_placeholder")}
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors duration-200 focus:border-accent sm:max-w-[220px]"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-foreground transition-opacity duration-200 disabled:opacity-50"
        >
          {t("actions.save")}
        </button>
        <button
          type="button"
          onClick={() => setShowPreview((value) => !value)}
          disabled={!baseUrl.trim()}
          className="rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground disabled:opacity-50"
        >
          {showPreview
            ? t("settings.rsshub_hide_preview")
            : t("settings.rsshub_preview", { count: pending.length })}
        </button>
        {pending.length > 0 && (
          <button
            type="button"
            onClick={handleApply}
            disabled={isApplying}
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium transition-colors duration-200 hover:bg-item-hover disabled:opacity-50"
          >
            {isApplying
              ? t("settings.rsshub_applying")
              : t("settings.rsshub_apply", { count: pending.length })}
          </button>
        )}
      </div>

      {showPreview && (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-surface/60 p-2">
          {pending.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("settings.rsshub_nothing_to_migrate")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {pending.map((item) => (
                <li key={item.feedId} className="px-2 py-1.5 text-xs">
                  <div className="font-medium text-foreground">{item.title}</div>
                  <div className="break-all text-muted-foreground">
                    {item.from}
                  </div>
                  <div className="break-all text-accent">{item.to}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={mergePlan !== null}
          onOpenChange={(open) => !open && setMergePlan(null)}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-lg">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {t("settings.rsshub_merge_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {t("settings.rsshub_merge_description")}
                </div>
                <ul className="mt-3 space-y-2">
                  {mergePlan?.conflicts.map((item) => (
                    <li
                      key={item.feedId}
                      className="rounded-lg border border-border p-2 text-xs"
                    >
                      <div className="font-medium text-foreground">
                        {item.title}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {t("settings.rsshub_merge_line", {
                          source: item.source.title,
                          sourceEntries: item.source.entries,
                          sourceStarred: item.source.starred,
                          target: item.target.title,
                          targetEntries: item.target.entries,
                          targetStarred: item.target.starred,
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
                {mergePlan && mergePlan.plain.length > 0 && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    {t("settings.rsshub_merge_also", {
                      count: mergePlan.plain.length,
                    })}
                  </div>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setMergePlan(null)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button
                  size="sm"
                  onPress={() => {
                    if (!mergePlan) return;
                    void runRewrites(
                      mergePlan.plain,
                      mergePlan.conflicts,
                      true,
                    );
                  }}
                >
                  {t("settings.rsshub_merge_confirm")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </section>
  );
}
