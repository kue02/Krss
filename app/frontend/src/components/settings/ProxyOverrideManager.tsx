import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@heroui/react";
import { Settings2 } from "lucide-react";
import { ChevronIcon } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TriStateControl } from "@/components/ui/tri-state-control";
import { ProxyEffectiveLine } from "@/components/settings/ProxyEffectiveLine";
import {
  useProxySources,
  useUpdateFeedProxy,
  useUpdateFolderProxy,
} from "@/hooks/useProxySources";
import { testNetworkProxy } from "@/api";
import { cn } from "@/lib/utils";
import type {
  ProxyEffective,
  ProxyFeedSource,
  ProxyGlobalConfig,
  ProxyMode,
  ProxyOverrideConfig,
  ProxyOverrideView,
} from "@/types/api";

/**
 * 代理覆盖 · 管理（14 批 · 效果图 proxy-per-source.html）。
 *
 * 一行一个来源（文件夹 / 订阅）：
 *   · 文件夹行最左是**展开/收起箭头** —— 沿用侧栏文件夹那一套（`ChevronIcon` + `rotate-90`，
 *     size-4 / duration-200）；收起后它下面的订阅隐藏，点回来还能展开；
 *   · 行上**直接显示生效结果**（「走代理 · 来自：文件夹「技术」」）；
 *   · 右侧三态就是订阅编辑弹窗里那套 `TriStateControl`（跟随上级 / 走代理 / 直连）；
 *   · 最右是「这一条的代理设置」行内图标按钮（lucide `Settings2`，与 外观→角标自定义
 *     同一个图标、与规则行 ⋯ 同一种写法），展开这一层自己的代理设置（默认收起）。
 *
 * 滚动：弹窗给固定高度 + **普通 div 的 `overflow-y-auto`**，与 `SettingsModal` 的
 * 「Content」那层同一做法。**刻意不用 HeroUI `Modal.Body` 自带的滚动** —— 在本项目里量到
 * 它只有可编程 scrollTop 能滚，用户的滚轮/键盘都进不去（`.modal__body--scroll-inside`
 * 是同一类「弹层交互进不去」的问题，见 docs/移植笔记.md 里 13-3 那条）。
 *
 * 一切以服务端算出来的 effective 为准 —— 前端不自己推「到底会走哪套」，
 * 免得和 `proxy_source_service.go` 里的解析顺序漂移。
 */
export function ProxyOverrideManager({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProxySources(open);
  /** 收起的文件夹 id（默认全展开；只影响显示，不动任何数据） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // 按文件夹分组：文件夹行在前，它的订阅紧随其后（效果图那个形态）；没有文件夹的订阅放最后一组
  const tree = useMemo(() => {
    if (!data) return [];
    const feedByFolder = new Map<string, ProxyFeedSource[]>();
    const loose: ProxyFeedSource[] = [];
    for (const feed of data.feeds) {
      if (!feed.folderId) {
        loose.push(feed);
        continue;
      }
      const list = feedByFolder.get(feed.folderId) ?? [];
      list.push(feed);
      feedByFolder.set(feed.folderId, list);
    }
    const folders = [...data.folders].sort((a, b) => a.name.localeCompare(b.name));
    const groups = folders.map((folder) => ({
      folder,
      feeds: feedByFolder.get(folder.id) ?? [],
    }));
    return [
      ...groups,
      {
        folder: null,
        feeds: loose,
      },
    ];
  }, [data]);

  return (
    <Modal>
      <Button className="hidden" aria-hidden />
      <Modal.Backdrop
        isOpen={open}
        onOpenChange={(next) => !next && onOpenChange(false)}
      >
        <Modal.Container>
          {/* 固定高度 + flex 列：中间那层才会成为真正能滚的容器（同 SettingsModal） */}
          <Modal.Dialog className="flex h-[80vh] max-h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
            <Modal.Header className="shrink-0 border-b border-border px-4 py-3">
              <Modal.Heading>{t("proxy.dialog_title")}</Modal.Heading>
            </Modal.Header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              {isLoading && (
                <div className="py-4 text-sm text-muted-foreground">
                  {t("entry.loading")}
                </div>
              )}
              {isError && (
                <div className="py-4 text-sm text-destructive">
                  {t("proxy.load_failed")}
                </div>
              )}

              {data && (
                <div className="space-y-3">
                  <GlobalSummary global={data.global} />

                  {tree.map((group) => {
                    const folderId = group.folder?.id;
                    const isCollapsed = folderId ? Boolean(collapsed[folderId]) : false;
                    return (
                      <div key={folderId ?? "__loose"} className="space-y-1">
                        {group.folder && (
                          <SourceRow
                            kind="folder"
                            id={group.folder.id}
                            title={group.folder.name}
                            subtitle={t("proxy.folder_feed_count", {
                              count: group.folder.feedCount,
                            })}
                            override={group.folder.override}
                            effective={group.folder.effective}
                            indented={false}
                            childCount={group.feeds.length}
                            collapsed={isCollapsed}
                            onToggleCollapsed={() =>
                              setCollapsed((prev) => ({
                                ...prev,
                                [group.folder!.id]: !prev[group.folder!.id],
                              }))
                            }
                          />
                        )}
                        {!isCollapsed &&
                          group.feeds.map((feed) => (
                            <SourceRow
                              key={feed.id}
                              kind="feed"
                              id={feed.id}
                              title={feed.title}
                              override={feed.override}
                              effective={feed.effective}
                              indented
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Modal.Footer className="shrink-0 border-t border-border px-4 py-3">
              <Button size="sm" variant="ghost" onPress={() => onOpenChange(false)}>
                {t("actions.close")}
              </Button>
            </Modal.Footer>
            <Modal.CloseTrigger />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** 全局那套代理：只读一行（改它去上面的「启用代理」区块） */
function GlobalSummary({ global }: { global: ProxyGlobalConfig }) {
  const { t } = useTranslation();
  const address = global.host ? `${global.host}:${global.port}` : "";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
      <span className="text-muted-foreground">
        {t("proxy.global_row")}
        {address && <span className="ml-2 font-mono text-foreground">{address}</span>}
      </span>
      <span
        className={cn(
          global.enabled ? "text-primary" : "text-muted-foreground",
        )}
      >
        {global.enabled ? t("proxy.global_enabled") : t("proxy.global_disabled")}
      </span>
    </div>
  );
}

type RowKind = "feed" | "folder";

function SourceRow({
  kind,
  id,
  title,
  subtitle,
  override,
  effective,
  indented,
  childCount,
  collapsed,
  onToggleCollapsed,
}: {
  kind: RowKind;
  id: string;
  title: string;
  subtitle?: string;
  override: ProxyOverrideView;
  effective: ProxyEffective;
  indented: boolean;
  /** 文件夹行才有：它下面挂着几条订阅（收起时用来交代「收起来了几个」） */
  childCount?: number;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t } = useTranslation();
  const updateFeedProxy = useUpdateFeedProxy();
  const updateFolderProxy = useUpdateFolderProxy();
  const [expanded, setExpanded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    { status: "idle" | "testing" | "ok" | "fail"; message?: string }
  >({ status: "idle" });

  const isCustomConfig = Boolean(override.config);
  const [draft, setDraft] = useState<ProxyOverrideConfig>(
    override.config ?? { type: "http", host: "", port: 0, username: "", password: "" },
  );
  const [configMode, setConfigMode] = useState<"global" | "custom">(
    isCustomConfig ? "custom" : "global",
  );

  const pending = updateFeedProxy.isPending || updateFolderProxy.isPending;

  const save = async (payload: {
    mode?: ProxyMode;
    config?: ProxyOverrideConfig | null;
  }) => {
    setErrorMsg(null);
    try {
      if (kind === "feed") {
        await updateFeedProxy.mutateAsync({ id, override: payload });
      } else {
        await updateFolderProxy.mutateAsync({ id, override: payload });
      }
      setSavedAt(Date.now());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("proxy.save_failed"));
    }
  };

  const handleTest = async () => {
    setTestState({ status: "testing" });
    try {
      const result = await testNetworkProxy({
        enabled: true,
        type: "http",
        host: "",
        port: 0,
        username: "",
        password: "",
        [kind === "feed" ? "feedId" : "folderId"]: id,
      });
      setTestState(
        result.success
          ? {
              status: "ok",
              message: result.message || t("settings.proxy_test_success"),
            }
          : {
              status: "fail",
              message: result.error || t("settings.proxy_test_failed"),
            },
      );
    } catch (err) {
      setTestState({
        status: "fail",
        message:
          err instanceof Error ? err.message : t("settings.proxy_test_failed"),
      });
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 px-3 py-2",
        indented && "ml-4",
        savedAt && "border-primary/40",
      )}
      data-slot="proxy-source-row"
      data-kind={kind}
      data-effective-mode={effective.mode}
      data-effective-source={effective.source}
      data-collapsed={collapsed ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {/* 文件夹行：展开 / 收起（与侧栏文件夹同一个箭头：ChevronIcon + rotate-90） */}
          {kind === "folder" && onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-expanded={!collapsed}
              aria-label={
                collapsed
                  ? t("proxy.folder_expand", { name: title })
                  : t("proxy.folder_collapse", { name: title })
              }
              title={
                collapsed
                  ? t("proxy.folder_expand", { name: title })
                  : t("proxy.folder_collapse", { name: title })
              }
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded",
                "text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
              )}
              data-slot="proxy-folder-toggle"
            >
              <ChevronIcon
                className={cn(
                  "size-4 transition-transform duration-200",
                  !collapsed && "rotate-90",
                )}
              />
            </button>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm text-foreground">{title}</div>
            {subtitle && (
              <div className="text-[11px] text-muted-foreground">
                {subtitle}
                {kind === "folder" && collapsed && childCount
                  ? ` · ${t("proxy.collapsed_count", { count: childCount })}`
                  : ""}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 行上直接给生效结果（验收口径） */}
          <ProxyEffectiveLine effective={effective} />
          <TriStateControl
            value={
              override.mode === "inherit" ? null : override.mode === "proxy"
            }
            onChange={(next) =>
              save({
                mode: next === null ? "inherit" : next ? "proxy" : "direct",
              })
            }
            inheritLabel={t("proxy.follow_parent")}
            onLabel={t("proxy.use_proxy")}
            offLabel={t("proxy.direct")}
          />
          {/* 「这一条的代理设置」：行内图标按钮（lucide Settings2），与规则行 ⋯ / 角标自定义同一枚图标 */}
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={
              kind === "folder"
                ? t("proxy.folder_settings_aria", { name: title })
                : t("proxy.feed_settings_aria", { name: title })
            }
            title={t("proxy.row_settings")}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
              "text-muted-foreground transition-colors",
              "hover:bg-secondary hover:text-foreground",
              expanded && "bg-secondary text-foreground",
            )}
            data-slot="proxy-row-settings"
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("proxy.config_source")}
            </span>
            <SegmentedControl
              value={configMode}
              onValueChange={(next) => {
                setConfigMode(next);
                if (next === "global") {
                  // 切回「全局那套」= 清掉这一层单独指定的配置
                  void save({ config: null });
                }
              }}
              options={[
                { value: "global", label: t("proxy.use_global_config") },
                { value: "custom", label: t("proxy.custom_config") },
              ]}
            />
          </div>

          {configMode === "custom" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  value={draft.type}
                  onValueChange={(type) => setDraft({ ...draft, type })}
                  options={[
                    { value: "http", label: "HTTP" },
                    { value: "socks5", label: "SOCKS5" },
                  ]}
                />
                <input
                  aria-label={t("settings.proxy_host")}
                  value={draft.host}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  placeholder="127.0.0.1"
                  className={inputClass}
                />
                <input
                  aria-label={t("settings.proxy_port")}
                  value={draft.port || ""}
                  inputMode="numeric"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      port: Number.parseInt(e.target.value, 10) || 0,
                    })
                  }
                  placeholder="7890"
                  className={cn(inputClass, "w-24")}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={t("settings.proxy_username")}
                  value={draft.username ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, username: e.target.value })
                  }
                  placeholder={t("settings.proxy_username")}
                  className={inputClass}
                />
                <input
                  aria-label={t("settings.proxy_password")}
                  type="password"
                  value={draft.password ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, password: e.target.value })
                  }
                  placeholder={t("settings.proxy_password")}
                  className={inputClass}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={pending}
                  onPress={() => save({ config: draft })}
                >
                  {t("proxy.save_config")}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={testState.status === "testing"}
              onPress={handleTest}
            >
              {testState.status === "testing"
                ? t("settings.proxy_testing")
                : t("proxy.test_this")}
            </Button>
            {testState.message && (
              <span
                className={cn(
                  "text-xs",
                  testState.status === "ok" && "text-green-600",
                  testState.status === "fail" && "text-destructive",
                )}
              >
                {testState.message}
              </span>
            )}
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="mt-2 text-xs text-destructive">{errorMsg}</div>
      )}
    </div>
  );
}

const inputClass =
  "h-8 min-w-32 flex-1 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30";
