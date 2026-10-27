import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip } from "@heroui/react";
import { fetchPlugins, rescanPlugins, setPluginEnabled } from "@/plugins/api";
import type { PluginMeta } from "@/plugins/types";
import { PLUGIN_SETTINGS_SECTIONS } from "@/plugins/registry";
import { PLUGIN_CONTRIBUTIONS_QUERY_KEY } from "@/plugins/useContributions";
import { PLUGIN_VIEWS_QUERY_KEY } from "@/plugins/usePluginViews";
import { queryClient } from "@/lib/queryClient";
import { HeroSwitch } from "@/components/ui/hero-switch";

/**
 * 设置 → 插件（55-8）。
 *
 * 这一页只做三件事：把清单列出来、能启停、给各插件的设置段留挂点。
 * - 清单 / 启停 / 崩溃原因全走 API（外挂插件与内置插件同一份出参）；
 * - 设置段是**代码**，随前端包发，按插件 id 在 `plugins/registry.tsx` 登记，
 *   没登记的插件只显示卡片（不报错，只是这段还没做）；
 * - 停用后设置段与自动化动作一并消失 —— 这里只管界面，动作失效由后端 dispatch 保证。
 */
export function PluginsSettings() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchPlugins()
      .then((list) => {
        if (alive) setPlugins(list);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const rescan = useCallback(async () => {
    setRescanning(true);
    setError(null);
    try {
      setPlugins(await rescanPlugins());
      // 56-4：新扫进来的外部插件会带进自己的界面贡献（右键菜单 / 工具栏…），
      // 停用也一样要它立刻从各挂点上消失 —— 这里让贡献表失效，挂点自己重拉一次。
      void queryClient.invalidateQueries({
        queryKey: PLUGIN_CONTRIBUTIONS_QUERY_KEY,
      });
      // 56-28：视图清单同理 —— 新插件带来自己的视图，停用的要从切换器上消失。
      void queryClient.invalidateQueries({ queryKey: PLUGIN_VIEWS_QUERY_KEY });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  }, []);

  const toggle = useCallback(async (plugin: PluginMeta, next: boolean) => {
    setBusyId(plugin.id);
    setError(null);
    try {
      // PATCH 直接回整份清单：启停后不用再补一次 GET，也不会出现「勾了但卡片还是旧的」
      setPlugins(await setPluginEnabled(plugin.id, next));
      // 56-4：启停改的正是「哪些插件在生效」，所以界面贡献跟着变 —— 不失效的话
      // 停用插件后它的右键菜单项会挂在那儿，点了才发现后端已经拒绝。
      void queryClient.invalidateQueries({
        queryKey: PLUGIN_CONTRIBUTIONS_QUERY_KEY,
      });
      // 56-28：停用插件的视图立刻从切换器消失；若正开着它的视图，路由钩子会把
      // `?view=` 摘掉并回落内置视图（不会白屏）。
      void queryClient.invalidateQueries({ queryKey: PLUGIN_VIEWS_QUERY_KEY });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          isDisabled={rescanning}
          onPress={() => void rescan()}
        >
          {rescanning ? t("plugins.rescanning") : t("plugins.rescan")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t("plugins.install_hint")}</p>

      {error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {!plugins ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const Section = PLUGIN_SETTINGS_SECTIONS[plugin.id];
            return (
              <section
                key={plugin.id}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <h3 className="text-sm font-medium text-foreground">
                        {plugin.name}
                      </h3>
                      {plugin.builtin && (
                        <Chip
                          size="sm"
                          variant="tertiary"
                          className="border border-border text-muted-foreground"
                        >
                          {t("plugins.builtin")}
                        </Chip>
                      )}
                      {plugin.transport === "http" && (
                        <Chip
                          size="sm"
                          variant="tertiary"
                          className="border border-border text-muted-foreground"
                        >
                          {t("plugins.external")}
                        </Chip>
                      )}
                      {plugin.version && (
                        <span className="text-[11px] text-muted-foreground/70">
                          v{plugin.version}
                        </span>
                      )}
                    </div>

                    {plugin.description && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {plugin.description}
                      </p>
                    )}

                    {/* 崩溃 / 起不来：宿主把原因写在 lastError 里，用户得一眼看见为什么点了没反应 */}
                    {plugin.lastError && (
                      <p className="mt-1 text-xs text-destructive">
                        {plugin.lastError}
                      </p>
                    )}
                  </div>

                  <HeroSwitch
                    aria-label={plugin.name}
                    isSelected={plugin.enabled}
                    isDisabled={busyId === plugin.id}
                    onChange={(checked: boolean) => void toggle(plugin, checked)}
                  >
                    {plugin.enabled
                      ? t("plugins.enabled")
                      : t("plugins.disabled")}
                  </HeroSwitch>
                </div>

                {plugin.enabled && Section && (
                  <div className="mt-3 border-t border-border pt-3">
                    <Section />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
