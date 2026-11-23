import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Edit2, Check, X, Gauge, Shield } from "lucide-react";
import { Button, Input, Label, NumberField } from "@heroui/react";
import {
  getDomainRateLimits,
  createDomainRateLimit,
  updateDomainRateLimit,
  deleteDomainRateLimit,
  getFetchSettings,
  updateFetchSettings,
  ApiError,
} from "@/api";
import type { FetchSettings, DomainRateLimit } from "@/types/settings";
import { AutoRefreshHistorySection } from "@/components/settings/tabs/AutoRefreshHistorySection";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/utils";

export function AdvancedSettings() {
  const { t } = useTranslation();
  const [items, setItems] = useState<DomainRateLimit[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // 拉取设置（用户 11-20）：定时频率 / 全局并发 / 同主机并发 / 单源超时。
  // 都是「下一轮生效」：后端每轮刷新开始时读一次，改完不用重启。
  const [fetchDraft, setFetchDraft] = useState<FetchSettings | null>(null);
  const [fetchSaving, setFetchSaving] = useState(false);
  /**
   * 最新草稿的 ref。
   *
   * HeroUI 的 NumberField（底层 react-aria）**只在失焦/回车时才提交值** ——
   * 于是「改完直接点保存」时 state 还是旧值（按钮还是禁用态，点了没反应，最难查的那种失败）。
   * 点保存本身会让输入框失焦、onChange 立刻触发，只是那次 setState 赶不上这次点击的闭包；
   * 所以这里同时写一份 ref，保存时以 ref 为准。
   */
  const draftRef = useRef<FetchSettings | null>(null);
  const [fetchStatus, setFetchStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const loadFetchSettings = useCallback(async () => {
    try {
      const data = await getFetchSettings();
      setFetchDraft(data);
      draftRef.current = data;
    } catch {
      // 读不到就整块不显示，不要摆一堆 0 让人以为设置坏了
    }
  }, []);

  useEffect(() => {
    void loadFetchSettings();
  }, [loadFetchSettings]);

  const handleSaveFetch = useCallback(async () => {
    // 以 ref 为准：失焦提交的值可能还没进 state（见 draftRef 注释）
    const draft = draftRef.current ?? fetchDraft;
    if (!draft) return;
    setFetchSaving(true);
    setFetchStatus(null);
    try {
      const saved = await updateFetchSettings(draft);
      setFetchDraft(saved);
      draftRef.current = saved;
      setFetchStatus({ kind: "ok", text: t("settings.fetch_saved") });
    } catch (error) {
      setFetchStatus({
        kind: "error",
        text:
          error instanceof ApiError
            ? error.message
            : t("settings.fetch_save_failed"),
      });
    } finally {
      setFetchSaving(false);
    }
  }, [fetchDraft, t]);

  // Add state
  const [newHost, setNewHost] = useState("");
  const [newInterval, setNewInterval] = useState("");

  // Edit state
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editInterval, setEditInterval] = useState<number>(0);

  const loadData = useCallback(async () => {
    try {
      const data = await getDomainRateLimits();
      setItems(data.items);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const isValidHostFormat = (h: string) => {
    const trimmed = h.trim();
    if (!trimmed) return false;
    if (trimmed === "localhost") return true;

    // IPv4 check
    const ipv4Regex =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (ipv4Regex.test(trimmed)) return true;

    // IPv6 check (simplified but robust enough for frontend)
    if (trimmed.includes(":")) {
      const ipv6Regex =
        /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4})?::(([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4})?$/;
      return ipv6Regex.test(trimmed);
    }

    // Domain check (RFC 1123, requires at least one dot)
    const domainRegex =
      /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return domainRegex.test(trimmed);
  };

  const handleCreate = async () => {
    if (!newHost.trim() || !isValidHostFormat(newHost)) return;

    const interval = Math.max(0, parseInt(newInterval) || 0);
    try {
      await createDomainRateLimit(newHost.trim(), interval);
      setNewHost("");
      setNewInterval("");
      await loadData();
    } catch {
      // ignore
    }
  };

  const startEdit = (item: DomainRateLimit) => {
    setEditingHost(item.host);
    setEditInterval(item.intervalSeconds);
  };

  const cancelEdit = () => {
    setEditingHost(null);
    setEditInterval(0);
  };

  const handleUpdate = async () => {
    if (!editingHost) return;
    try {
      await updateDomainRateLimit(editingHost, editInterval);
      setEditingHost(null);
      await loadData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (host: string) => {
    if (!confirm(t("settings.confirm_delete") || "Are you sure?")) return;
    try {
      await deleteDomainRateLimit(host);
      await loadData();
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const fetchRows: Array<{
    key: keyof FetchSettings;
    label: string;
    hint: string;
    min: number;
    max: number;
  }> = [
    {
      key: "intervalMinutes",
      label: t("settings.fetch_interval"),
      hint: t("settings.fetch_interval_hint"),
      min: 1,
      max: 1440,
    },
    {
      key: "concurrency",
      label: t("settings.fetch_concurrency"),
      hint: t("settings.fetch_concurrency_hint"),
      min: 1,
      max: 64,
    },
    {
      key: "perHostConcurrency",
      label: t("settings.fetch_per_host"),
      hint: t("settings.fetch_per_host_hint"),
      min: 1,
      max: 64,
    },
    {
      key: "timeoutSeconds",
      label: t("settings.fetch_timeout"),
      hint: t("settings.fetch_timeout_hint"),
      min: 1,
      max: 300,
    },
  ];

  return (
    <div className="space-y-5">
      {/* 自动刷新历史（用户 12-17；第十九批重做）：定时刷新结果不再弹框，来这里回看。 */}
      <AutoRefreshHistorySection />

      {/* 拉取：频率与并发（用户 11-20） */}
      {fetchDraft && (
        <SectionCard
          icon={<Gauge className="size-4" />}
          title={t("settings.fetch_title")}
          description={t("settings.fetch_description")}
        >
          <div className="divide-y divide-border/50">
            {fetchRows.map((row) => (
              <SettingRow key={row.key} label={row.label} hint={row.hint}>
                <NumberField
                  value={fetchDraft[row.key]}
                  minValue={row.min}
                  maxValue={row.max}
                  onChange={(value) =>
                    setFetchDraft((prev) => {
                      if (!prev) return prev;
                      const next = { ...prev, [row.key]: Number(value) || 0 };
                      draftRef.current = next;
                      return next;
                    })
                  }
                  className="w-32"
                >
                  <Label className="sr-only">{row.label}</Label>
                  <NumberField.Group>
                    <NumberField.DecrementButton>-</NumberField.DecrementButton>
                    <NumberField.Input />
                    <NumberField.IncrementButton>+</NumberField.IncrementButton>
                  </NumberField.Group>
                </NumberField>
              </SettingRow>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 px-1 pb-2 pt-3">
            <Button
              size="sm"
              variant="primary"
              onPress={handleSaveFetch}
              isDisabled={fetchSaving}
            >
              {t("actions.save")}
            </Button>
            <div className="text-xs text-muted-foreground">
              {t("settings.fetch_scope_hint")}
            </div>
            {fetchStatus && (
              <span
                className={cn(
                  "text-xs",
                  fetchStatus.kind === "ok"
                    ? "text-muted-foreground"
                    : "text-destructive",
                )}
              >
                {fetchStatus.text}
              </span>
            )}
          </div>
        </SectionCard>
      )}

      {/* Domain Rate Limits Section */}
      <SectionCard
        icon={<Shield className="size-4" />}
        title={t("settings.advanced_domain_limits")}
        description={t("settings.advanced_domain_limits_description")}
      >
        <div className="space-y-2 px-1 py-2.5">
          {/* Add Row */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="example.com"
              aria-label={t("settings.advanced_host")}
              className="h-9 min-w-[120px] flex-1 text-sm"
            />
            <div className="flex shrink-0 items-center gap-2">
              <Input
                type="number"
                min="0"
                value={newInterval}
                onChange={(e) => setNewInterval(e.target.value)}
                placeholder={t("settings.advanced_seconds")}
                aria-label={t("settings.advanced_interval")}
                className="h-9 w-24 text-sm"
              />
              <Button
                size="sm"
                variant="secondary"
                isIconOnly
                onPress={handleCreate}
                isDisabled={!newHost.trim() || !isValidHostFormat(newHost)}
                aria-label={t("settings.advanced_add_domain")}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          {/* List */}
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t("settings.advanced_no_domains")}
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => {
                const isEditing = editingHost === item.host;
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary/25"
                  >
                    <div
                      className="min-w-[120px] flex-1 px-2 text-sm font-mono truncate"
                      title={item.host}
                    >
                      {item.host}
                    </div>

                    {isEditing ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Input
                          type="number"
                          min="0"
                          value={editInterval}
                          autoFocus
                          onChange={(e) =>
                            setEditInterval(
                              Math.max(0, parseInt(e.target.value) || 0),
                            )
                          }
                          aria-label={t("settings.advanced_interval")}
                          className="h-9 w-24 text-sm"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          onPress={handleUpdate}
                          aria-label={t("settings.advanced_edit")}
                          className="text-primary hover:bg-primary/10"
                        >
                          <Check className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          onPress={cancelEdit}
                          aria-label={t("actions.cancel")}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <div className="w-20 text-center text-xs text-muted-foreground">
                          {item.intervalSeconds}s
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          onPress={() => startEdit(item)}
                          aria-label={t("settings.advanced_edit")}
                        >
                          <Edit2 className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          onPress={() => handleDelete(item.host)}
                          aria-label={t("settings.advanced_delete")}
                          className="hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
