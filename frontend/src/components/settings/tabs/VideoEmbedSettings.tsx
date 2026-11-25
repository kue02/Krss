import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip, Input } from "@heroui/react";
import { MonitorPlay, Plus, X } from "lucide-react";
import {
  setUISetting,
  useUISettingKey,
} from "@/hooks/useUISettings";
import { normalizeIframeVideoHost } from "@/lib/video-embed";
import { SectionCard, SettingRow } from "@/components/settings/settings-primitives";
import { Switch } from "@/components/ui/switch";

/**
 * 正文视频设置（外观 / 阅读与列表之后）：
 * - 未知站点的 iframe 是否「点击加载」；
 * - 用户自定义的 iframe 白名单（内置 B 站 / YouTube / Wistia 不用写）。
 *
 * 直接视频文件（.mp4/.webm/.m3u8…）不需要配置：正文为空时自动用内置播放器播放。
 */
export function VideoEmbedSettings() {
  const { t } = useTranslation();
  const hosts = useUISettingKey("iframeVideoHosts") ?? [];
  const unknownClickToLoad =
    useUISettingKey("iframeUnknownClickToLoad") !== false;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addHost = () => {
    const normalized = normalizeIframeVideoHost(input);
    if (!normalized) {
      setError(t("appearance_video.invalid"));
      return;
    }
    if (hosts.includes(normalized)) {
      setError(t("appearance_video.duplicate"));
      return;
    }
    setUISetting("iframeVideoHosts", [...hosts, normalized]);
    setInput("");
    setError(null);
  };

  const removeHost = (host: string) => {
    setUISetting(
      "iframeVideoHosts",
      hosts.filter((item) => item !== host),
    );
  };

  return (
    <SectionCard
      icon={<MonitorPlay className="size-4" strokeWidth={1.75} />}
      title={t("appearance_video.title")}
      description={t("appearance_video.description")}
    >
      <div className="divide-y divide-border/50">
        <SettingRow
          label={t("appearance_video.unknown_click")}
          hint={t("appearance_video.unknown_click_hint")}
        >
          <Switch
            checked={unknownClickToLoad}
            onCheckedChange={(checked) =>
              setUISetting("iframeUnknownClickToLoad", checked)
            }
            aria-label={t("appearance_video.unknown_click")}
          />
        </SettingRow>

        <div className="px-1 py-3">
          <div className="text-sm text-foreground">
            {t("appearance_video.extra_hosts")}
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("appearance_video.extra_hosts_hint")}
            </div>
          </div>

          <div className="mt-2.5 flex items-start gap-2">
            <Input
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addHost();
                }
              }}
              placeholder={t("appearance_video.placeholder")}
              aria-label={t("appearance_video.extra_hosts")}
              className="min-w-0 flex-1"
            />
            <Button variant="tertiary" onPress={addHost}>
              <Plus className="size-4" aria-hidden="true" />
              {t("appearance_video.add")}
            </Button>
          </div>

          {error && (
            <p role="alert" className="mt-1.5 text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {hosts.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("appearance_video.empty")}
              </span>
            ) : (
              hosts.map((host) => (
                <span key={host} className="inline-flex items-center">
                  <Chip
                    size="sm"
                    variant="tertiary"
                    className="border border-border text-muted-foreground"
                  >
                    {host}
                  </Chip>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    className="-ms-1 size-6 min-w-6 text-muted-foreground"
                    onPress={() => removeHost(host)}
                    aria-label={t("appearance_video.remove", { host })}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                </span>
              ))
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("appearance_video.builtin")}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
