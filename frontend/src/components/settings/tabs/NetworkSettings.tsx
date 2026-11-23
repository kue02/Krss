import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import {
  getNetworkSettings,
  updateNetworkSettings,
  testNetworkProxy,
  getProxyMemory,
  clearProxyMemory,
} from "@/api";
import { useProxySources } from "@/hooks/useProxySources";
import { ProxyOverrideManager } from "@/components/settings/ProxyOverrideManager";
import type {
  NetworkSettings as NetworkSettingsType,
  ProxyType,
  IPStack,
} from "@/types/settings";
import type { ProxyDomainMemoryItem } from "@/types/api";
import { cn } from "@/lib/utils";
import { showToast } from "@/stores/toast-store";
import { Button, Input } from "@heroui/react";
import { ChevronRight, Globe, Network, Server, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  GroupLabel,
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";

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
    mode: "proxy",
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
  /** 50 批 2.1：关掉代理后配置收成一行摘要，这里管「展开编辑」 */
  const [configExpanded, setConfigExpanded] = useState(false);
  /** 50 批 2.2：智能档的域记忆（列表 + 清空中状态） */
  const [memory, setMemory] = useState<ProxyDomainMemoryItem[] | null>(null);
  const [clearingMemory, setClearingMemory] = useState(false);
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
        // 老库没有 mode 键：后端返回空串，按旧行为=proxy 归一
        setSettings({ ...data, mode: data.mode === "smart" ? "smart" : "proxy" });
        setBaseline(JSON.stringify({ ...data, mode: data.mode === "smart" ? "smart" : "proxy" }));
      })
      .catch(() => {
        // ignore
      });
    getProxyMemory()
      .then(setMemory)
      .catch(() => setMemory([]));
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

  const handleModeChange = async (mode: "proxy" | "smart") => {
    const newSettings = { ...settings, mode };
    setSettings(newSettings);
    try {
      await updateNetworkSettings(newSettings);
      setBaseline(JSON.stringify(newSettings));
    } catch {
      // Revert on error
      setSettings(settings);
    }
  };

  const handleClearMemory = async () => {
    setClearingMemory(true);
    try {
      const result = await clearProxyMemory();
      setMemory([]);
      showToast(t("settings.proxy_memory_cleared", { count: result.cleared }));
    } catch {
      showToast(t("settings.proxy_memory_clear_failed"));
    } finally {
      setClearingMemory(false);
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

  const proxyModeOptions = useMemo(
    () => [
      { value: "proxy" as const, label: t("settings.proxy_mode_proxy") },
      { value: "smart" as const, label: t("settings.proxy_mode_smart") },
    ],
    [t],
  );

  const canTest = settings.host && settings.port > 0;

  /** 50 批 2.1：收起时那行摘要——「代理已关闭 · HTTP 127.0.0.1:7890」；没填完整就给引导文案 */
  const configSummary = settings.enabled
    ? null
    : settings.host && settings.port > 0
      ? t("settings.proxy_disabled_summary", {
          type: settings.type.toUpperCase(),
          host: settings.host,
          port: settings.port,
        })
      : t("settings.proxy_disabled_empty");

  return (
    <div className="space-y-5">
      {/* 网络栈：IP 协议优先级 */}
      <SectionCard
        icon={<Globe className="size-4" />}
        title={t("settings.ip_stack")}
        description={t("settings.ip_stack_description")}
      >
        <div className="px-1 py-2.5">
          <SegmentedControl
            value={settings.ipStack}
            onValueChange={handleIPStackChange}
            options={ipStackOptions}
          />
        </div>
      </SectionCard>

      {/* 代理总开关 + 模式 + 智能档记忆 */}
      <SectionCard
        icon={<Network className="size-4" />}
        title={t("settings.proxy_enabled")}
        description={t("settings.proxy_enabled_description")}
        action={
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleEnabledChange}
          />
        }
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("settings.proxy_mode")}
            hint={t("settings.proxy_mode_description")}
            disabled={!settings.enabled}
          >
            <SegmentedControl
              className="shrink-0"
              value={settings.mode}
              onValueChange={handleModeChange}
              options={proxyModeOptions}
            />
          </SettingRow>

          {settings.mode === "smart" && (
            <SettingRow
              label={t("settings.proxy_memory_title")}
              hint={t("settings.proxy_memory_description")}
            >
              <Button
                size="sm"
                variant="outline"
                onPress={handleClearMemory}
                isDisabled={clearingMemory || !memory || memory.length === 0}
              >
                {t("settings.proxy_memory_clear")}
              </Button>
            </SettingRow>
          )}
        </div>

        {settings.mode === "smart" && memory && memory.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2 pt-1">
            {memory.map((item) => (
              <span
                key={item.host}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              >
                {item.host}
                <span
                  className={cn(
                    "ml-1.5",
                    item.mode === "proxy"
                      ? "text-primary"
                      : "text-green-600 dark:text-green-400",
                  )}
                >
                  {item.mode === "proxy"
                    ? t("settings.proxy_memory_mode_proxy")
                    : t("settings.proxy_memory_mode_direct")}
                </span>
              </span>
            ))}
          </div>
        )}
        {settings.mode === "smart" && memory && memory.length === 0 && (
          <p className="px-1 pb-2 pt-1 text-xs text-muted-foreground">
            {t("settings.proxy_memory_empty")}
          </p>
        )}
      </SectionCard>

      {/* 按来源覆盖：订阅 / 文件夹各自覆盖全局代理，就近优先 */}
      <SectionCard
        icon={<ShieldCheck className="size-4" />}
        title={t("proxy.section_title")}
        description={t("proxy.section_description")}
        action={
          <Button
            size="sm"
            variant="outline"
            onPress={() => setManagerOpen(true)}
          >
            {t("proxy.manage")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-1 py-2.5">
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
      </SectionCard>

      {/* 代理配置：关掉代理后收成一行摘要，点开仍能编辑；测试按钮不再被禁用区困住 */}
      <SectionCard
        icon={<Server className="size-4" />}
        title={t("settings.proxy_config_title")}
      >
        {!settings.enabled && !configExpanded ? (
          <div className="px-1 py-2.5">
            <button
              type="button"
              onClick={() => setConfigExpanded(true)}
              className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-border px-3 py-2 text-left transition-colors duration-200 hover:bg-item-hover"
            >
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {configSummary}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <>
            {configExpanded && !settings.enabled && (
              <div className="px-1 pt-2">
                <button
                  type="button"
                  onClick={() => setConfigExpanded(false)}
                  className="text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
                >
                  {t("settings.proxy_collapse")}
                </button>
              </div>
            )}

            <div className="divide-y divide-border/50">
              <SettingRow label={t("settings.proxy_type")}>
                <SegmentedControl
                  className="shrink-0"
                  value={settings.type}
                  onValueChange={handleTypeChange}
                  options={proxyTypeOptions}
                />
              </SettingRow>

              <SettingRow label={t("settings.proxy_host")}>
                <Input
                  type="text"
                  value={settings.host}
                  onChange={(e) =>
                    setSettings({ ...settings, host: e.target.value })
                  }
                  placeholder="127.0.0.1"
                  className="w-44"
                />
              </SettingRow>

              <SettingRow label={t("settings.proxy_port")}>
                <Input
                  type="number"
                  value={settings.port || ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      port: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  placeholder="7890"
                  className="w-24"
                />
              </SettingRow>
            </div>

            <GroupLabel>{t("settings.proxy_auth")}</GroupLabel>
            <div className="divide-y divide-border/50">
              <SettingRow label={t("settings.proxy_username")}>
                <Input
                  type="text"
                  value={settings.username}
                  onChange={(e) =>
                    setSettings({ ...settings, username: e.target.value })
                  }
                  className="w-44"
                />
              </SettingRow>

              <SettingRow label={t("settings.proxy_password")}>
                <Input
                  type="password"
                  value={settings.password}
                  onChange={(e) =>
                    setSettings({ ...settings, password: e.target.value })
                  }
                  className="w-44"
                />
              </SettingRow>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-1 pb-2 pt-3">
              <Button
                size="sm"
                variant="outline"
                onPress={handleTest}
                isDisabled={isTesting || !canTest}
                className={cn(
                  testStatus === "success" && "border-green-600 text-green-600",
                  testStatus === "error" &&
                    "border-destructive text-destructive",
                )}
              >
                {isTesting
                  ? t("settings.proxy_testing")
                  : t("settings.proxy_test")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onPress={handleSave}
                isDisabled={isSaving}
                className={cn(
                  saveStatus === "success" &&
                    "bg-green-600 text-white hover:bg-green-600",
                  saveStatus === "error" &&
                    "bg-destructive text-destructive-foreground hover:bg-destructive",
                )}
              >
                {isSaving
                  ? t("settings.saving")
                  : saveStatus === "success"
                    ? t("settings.saved")
                    : t("settings.save")}
              </Button>
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
          </>
        )}
      </SectionCard>

      {/* 覆盖管理面板（弹层，与效果图一致：列表 + 单条 ⚙ 展开） */}
      <ProxyOverrideManager open={managerOpen} onOpenChange={setManagerOpen} />
    </div>
  );
}
