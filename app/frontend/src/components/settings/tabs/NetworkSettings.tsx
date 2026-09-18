import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import {
  getNetworkSettings,
  updateNetworkSettings,
  testNetworkProxy,
} from "@/api";
import { useProxySources } from "@/hooks/useProxySources";
import { ProxyOverrideManager } from "@/components/settings/ProxyOverrideManager";
import type {
  NetworkSettings as NetworkSettingsType,
  ProxyType,
  IPStack,
} from "@/types/settings";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";

export function NetworkSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<NetworkSettingsType>({
    enabled: false,
    type: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
    ipStack: "default",
  });
  const [isSaving, setIsSaving] = useState(false);
  /** 12-7：加载/保存成功时的快照，用来判断「有没有未保存的改动」 */
  const [baseline, setBaseline] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const [testStatus, setTestStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const [testMessage, setTestMessage] = useState("");
  // 按来源覆盖（14 批）：计数来自服务端一览，管理面板单独弹
  const [managerOpen, setManagerOpen] = useState(false);
  const { data: proxySources } = useProxySources();
  const counts = {
    folders: proxySources?.counts.folders ?? 0,
    feeds: proxySources?.counts.feeds ?? 0,
    proxiedFeeds: proxySources?.counts.proxiedFeeds ?? 0,
    globalEnabled: proxySources?.counts.globalEnabled ?? false,
    // 没拿到数据时不显示「全局未启用」那条警告（避免把「还没加载」显示成结论）
    known: Boolean(proxySources),
  };

  useEffect(() => {
    getNetworkSettings()
      .then((data) => {
        setSettings(data);
        setBaseline(JSON.stringify(data));
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const handleEnabledChange = async (checked: boolean) => {
    const newSettings = { ...settings, enabled: checked };
    setSettings(newSettings);
    try {
      await updateNetworkSettings(newSettings);
      setBaseline(JSON.stringify(newSettings));
    } catch {
      // Revert on error
      setSettings(settings);
    }
  };

  const handleTypeChange = (type: ProxyType) => {
    setSettings({ ...settings, type });
  };

  const handleIPStackChange = async (ipStack: IPStack) => {
    const newSettings = { ...settings, ipStack };
    setSettings(newSettings);
    try {
      await updateNetworkSettings(newSettings);
      setBaseline(JSON.stringify(newSettings));
    } catch {
      // Revert on error
      setSettings(settings);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus("idle");
    try {
      await updateNetworkSettings(settings);
      setBaseline(JSON.stringify(settings));
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const networkDirty =
    baseline !== null && JSON.stringify(settings) !== baseline;
  useSettingsDirty("network", networkDirty, t("settings.dirty_label_network"), () =>
    handleSave(),
  );

  const handleTest = async () => {
    setIsTesting(true);
    setTestStatus("idle");
    setTestMessage("");
    try {
      const result = await testNetworkProxy(settings);
      if (result.success) {
        setTestStatus("success");
        setTestMessage(result.message || t("settings.proxy_test_success"));
      } else {
        setTestStatus("error");
        setTestMessage(result.error || t("settings.proxy_test_failed"));
      }
    } catch (err) {
      setTestStatus("error");
      setTestMessage(
        err instanceof Error ? err.message : t("settings.proxy_test_failed"),
      );
    } finally {
      setIsTesting(false);
      setTimeout(() => {
        setTestStatus("idle");
        setTestMessage("");
      }, 3000);
    }
  };

  const proxyTypeOptions = useMemo(
    () => [
      { value: "http" as ProxyType, label: "HTTP" },
      { value: "socks5" as ProxyType, label: "SOCKS5" },
    ],
    [],
  );

  const ipStackOptions = useMemo(
    () => [
      { value: "default" as IPStack, label: t("settings.ip_stack_default") },
      { value: "ipv4" as IPStack, label: t("settings.ip_stack_ipv4") },
      { value: "ipv6" as IPStack, label: t("settings.ip_stack_ipv6") },
    ],
    [t],
  );

  const canTest = settings.host && settings.port > 0;

  return (
    <div className="space-y-6">
      {/* IP Stack */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("settings.ip_stack")}</div>
            <div className="text-xs text-muted-foreground">
              {t("settings.ip_stack_description")}
            </div>
          </div>
          <SegmentedControl
            className="shrink-0"
            value={settings.ipStack}
            onValueChange={handleIPStackChange}
            options={ipStackOptions}
          />
        </div>
      </section>

      {/* Enable Proxy */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("settings.proxy_enabled")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings.proxy_enabled_description")}
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleEnabledChange}
          />
        </div>
      </section>

      {/* 按来源覆盖（14 批）：订阅 / 文件夹可以各自覆盖全局代理，就近优先 */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("proxy.section_title")}</div>
            <div className="text-xs text-muted-foreground">
              {t("proxy.section_description")}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            className={cn(
              "h-8 shrink-0 rounded-md px-3 text-sm font-medium transition-colors",
              "border border-border bg-background hover:bg-secondary",
            )}
          >
            {t("proxy.manage")}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {t("proxy.counts_folders", { count: counts.folders })}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {t("proxy.counts_feeds", { count: counts.feeds })}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {t("proxy.counts_proxied", { count: counts.proxiedFeeds })}
          </span>
          {/* 全局总开关没开：只有「单独指定」的来源能走代理，说清楚免得被当成 bug */}
          {counts.known && !counts.globalEnabled && (
            <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
              {t("proxy.global_disabled_warning")}
            </span>
          )}
        </div>
      </section>

      {/* Proxy Configuration */}
      <section
        className={cn(!settings.enabled && "opacity-50 pointer-events-none")}
      >
        <div className="space-y-4">
          {/* Proxy Type */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {t("settings.proxy_type")}
            </div>
            <SegmentedControl
              className="shrink-0"
              value={settings.type}
              onValueChange={handleTypeChange}
              options={proxyTypeOptions}
            />
          </div>

          {/* Host and Port */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="text-sm font-medium">
                {t("settings.proxy_host")}
              </label>
              <input
                type="text"
                value={settings.host}
                onChange={(e) =>
                  setSettings({ ...settings, host: e.target.value })
                }
                placeholder="127.0.0.1"
                className={cn(
                  "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm",
                  "placeholder:text-muted-foreground/50",
                  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                )}
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                {t("settings.proxy_port")}
              </label>
              <input
                type="number"
                value={settings.port || ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    port: parseInt(e.target.value, 10) || 0,
                  })
                }
                placeholder="7890"
                className={cn(
                  "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm",
                  "placeholder:text-muted-foreground/50",
                  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                )}
              />
            </div>
          </div>

          {/* Authentication */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("settings.proxy_auth")}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">
                  {t("settings.proxy_username")}
                </label>
                <input
                  type="text"
                  value={settings.username}
                  onChange={(e) =>
                    setSettings({ ...settings, username: e.target.value })
                  }
                  className={cn(
                    "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm",
                    "placeholder:text-muted-foreground/50",
                    "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                  )}
                />
              </div>
              <div>
                <label className="text-sm font-medium">
                  {t("settings.proxy_password")}
                </label>
                <input
                  type="password"
                  value={settings.password}
                  onChange={(e) =>
                    setSettings({ ...settings, password: e.target.value })
                  }
                  className={cn(
                    "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm",
                    "placeholder:text-muted-foreground/50",
                    "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                  )}
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={isTesting || !canTest}
              className={cn(
                "h-9 rounded-md px-4 text-sm font-medium transition-colors shrink-0",
                "border border-border bg-background hover:bg-secondary",
                "disabled:cursor-not-allowed disabled:opacity-50",
                testStatus === "success" && "border-green-600 text-green-600",
                testStatus === "error" && "border-destructive text-destructive",
              )}
            >
              {isTesting
                ? t("settings.proxy_testing")
                : t("settings.proxy_test")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className={cn(
                "h-9 rounded-md px-4 text-sm font-medium transition-colors shrink-0",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                saveStatus === "success" && "bg-green-600 hover:bg-green-600",
                saveStatus === "error" && "bg-destructive hover:bg-destructive",
              )}
            >
              {isSaving
                ? t("settings.saving")
                : saveStatus === "success"
                  ? t("settings.saved")
                  : t("settings.save")}
            </button>
            {testMessage && (
              <span
                className={cn(
                  "text-sm",
                  testStatus === "success" && "text-green-600",
                  testStatus === "error" && "text-destructive",
                )}
              >
                {testMessage}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 覆盖管理面板（弹层，与效果图一致：列表 + 单条 ⚙ 展开） */}
      <ProxyOverrideManager open={managerOpen} onOpenChange={setManagerOpen} />
    </div>
  );
}
