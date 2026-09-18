import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { Settings2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
 * 滚动：**壳必须用项目自己的 Dialog（Radix）**，不能用 HeroUI `Modal`。
 * 真机取证（2026-09-18）：HeroUI Modal 的内容被 portal 到 `document.body`，而外面那层设置弹窗是
 * Radix `DialogContent` —— Radix 的滚动锁 `react-remove-scroll` 在 `document` 上装了 wheel 监听，
 * 凡是**不在它 shard（设置弹窗自己的 DOM 子树）内**的滚轮事件一律 `preventDefault()` 吃掉。
 * 抓到的调用栈就是 `.vite/deps/Combination-*.js`（react-remove-scroll 的 `shouldPrevent`）。
 * 所以 HeroUI Modal 里的列表（不管怎么写 overflow）滚轮都进不去 —— 症状就是「页面不能滑动」。
 * 换成项目自己的 Dialog 后，它自己注册 shard、内容在 shard 内，滚轮正常。
 * 骨架照抄 SettingsModal：DialogContent 固定高度 + `overflow-hidden` → flex 列 → 中间
 * `min-h-0 flex-1 overflow-y-auto` 那层才是真滚动容器。
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-h-[85vh] w-[880px] max-w-[95vw] gap-0 overflow-hidden p-0">
        {/* 和 SettingsModal 同一套骨架：DialogContent 固定高度 → flex 列 → 中间那层才真能滚 */}
        <div className="flex h-full min-h-0 flex-col bg-background">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4">
            <DialogTitle className="text-xl font-bold">
              {t("proxy.dialog_title")}
            </DialogTitle>
            <span className="text-xs text-muted-foreground">
              {t("proxy.dialog_subtitle")}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-slot="proxy-manager-scroll">
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

          <div className="flex shrink-0 items-center justify-end border-t border-border px-6 py-3">
            <Button size="sm" variant="ghost" onPress={() => onOpenChange(false)}>
              {t("actions.close")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
          {/* 文件夹行有箭头槽位（20px + 4px 间隙），订阅行补上等宽内缩，
              让子项名字落在父文件夹名字右侧 ~14px（效果图里就是这个层级感） */}
          <div className={cn("min-w-0", indented && "pl-6")}>
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
