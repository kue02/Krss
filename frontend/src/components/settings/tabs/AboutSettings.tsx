import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@heroui/react";
import {
  AlertCircle,
  ArrowUpCircle,
  Bug,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { checkForUpdate } from "@/api";
import type { UpdateCheckResult } from "@/types/settings";
import { parseHtml } from "@/lib/parse-html";
import { cn } from "@/lib/utils";

const version =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const TECH_STACK = "React · TypeScript · Go · SQLite";

type UpdateStatus = "checking" | "success" | "error";

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 015.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A11.5 11.5 0 0023.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

const LINKS = [
  {
    key: "repo",
    href: "https://github.com/kue02/Krss",
    icon: GithubMark,
  },
  {
    key: "issues",
    href: "https://github.com/kue02/Krss/issues",
    icon: Bug,
  },
  {
    key: "releases",
    href: "https://github.com/kue02/Krss/releases",
    icon: Sparkles,
  },
] as const;

export function AboutSettings() {
  const { t } = useTranslation();

  const [status, setStatus] = useState<UpdateStatus>("checking");
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchUpdate = useCallback(async () => {
    try {
      const res = await checkForUpdate();
      setResult(res);
      setCheckedAt(new Date());
      setErrorMessage(null);
      setStatus("success");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStatus("error");
    }
  }, []);

  const runCheck = useCallback(async () => {
    setStatus("checking");
    setErrorMessage(null);
    await fetchUpdate();
  }, [fetchUpdate]);

  // 打开「关于」页自动检查一次。后端有 10 分钟缓存，重复进入不会额外打 GitHub。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: 打开「关于」页即自动检查一次，结果写入本地状态
    void fetchUpdate();
  }, [fetchUpdate]);

  const hasUpdate = status === "success" && !!result?.hasUpdate;

  const releaseNotes = useMemo(() => {
    if (!result?.releaseNotesHtml) return null;
    try {
      return parseHtml(result.releaseNotesHtml).toContent();
    } catch {
      return null;
    }
  }, [result]);

  return (
    <div className="space-y-5">
      {/* 更新提示：有更新时放在最上方，最显眼 */}
      {hasUpdate && result && (
        <section className="relative overflow-hidden rounded-2xl border border-warning/40 bg-warning-soft p-4 shadow-nf-sm sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning-soft-foreground">
                <ArrowUpCircle className="size-5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {t("update.available")}
                  </h3>
                  <span className="rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 font-mono text-xs font-semibold text-warning-soft-foreground">
                    {result.latestVersion}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("update.banner_desc", { version: result.latestVersion })}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:pl-2">
              {/* 强调按钮刻意不用 variant="primary"：这套主题的 --accent 默认是 #000000，
                  暗色下会变成黑底黑字、和「有更新」的语义也对不上；
                  用 foreground 反色，两套主题都翻得过来（同 MCPServersSection 的主按钮） */}
              <Button
                size="sm"
                className="border border-foreground bg-foreground text-background shadow-none hover:bg-foreground/90"
                onPress={() => setDetailOpen(true)}
              >
                {t("update.view_details")}
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* 品牌区：保留应用身份，换成与设置页一致的卡片质感 */}
      <section className="overflow-hidden rounded-2xl border border-border/60 bg-card/30 p-5 shadow-nf-sm sm:p-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <img
            src="/logo.svg"
            alt="Krss"
            className="size-16 shrink-0 rounded-2xl shadow-nf sm:size-20"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                Krss
              </h2>
              {/* 版本徽章用 foreground 派生色：主题的 --accent 默认是 #000000，
                  暗色下 primary 会变成黑底黑字（本页其它处同理，见下方链接行） */}
              <span className="rounded-full border border-foreground/20 bg-foreground/5 px-2.5 py-0.5 font-mono text-xs font-medium text-foreground">
                v{version}
              </span>
            </div>
            <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
              {t("about.tagline")}
            </p>
          </div>
        </div>
      </section>

      {/* 版本更新 */}
      <SectionCard
        icon={
          <RefreshCw
            className={cn(
              "size-4",
              status === "checking" && "animate-spin",
            )}
            strokeWidth={1.75}
          />
        }
        title={t("update.check_title")}
        description={t("update.check_desc")}
        action={
          <Button
            size="sm"
            variant="outline"
            isDisabled={status === "checking"}
            onPress={() => void runCheck()}
          >
            {status === "checking" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                {t("update.checking")}
              </span>
            ) : result && !result.hasUpdate ? (
              t("update.recheck")
            ) : (
              t("update.check_now")
            )}
          </Button>
        }
      >
        <div className="divide-y divide-border/50">
          <SettingRow label={t("update.current_version")}>
            <span className="font-mono text-[13px] text-muted-foreground">
              v{result?.currentVersion ?? version}
            </span>
          </SettingRow>
          <SettingRow label={t("update.latest_version")}>
            {status === "checking" && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("update.checking")}
              </span>
            )}
            {status === "error" && (
              <span
                className="flex items-center gap-1.5 text-sm text-destructive"
                title={errorMessage ?? undefined}
              >
                <AlertCircle className="size-4" />
                {t("update.check_failed")}
              </span>
            )}
            {status === "success" && result && (
              <span
                className={cn(
                  "flex items-center gap-1.5 text-sm",
                  result.hasUpdate
                    ? "font-medium text-warning-soft-foreground"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {result.hasUpdate ? (
                  <ArrowUpCircle className="size-4" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                <span className="font-mono text-[13px]">
                  {result.latestVersion}
                </span>
                <span className="text-muted-foreground">
                  {result.hasUpdate
                    ? t("update.has_update_short")
                    : t("update.up_to_date_short")}
                </span>
              </span>
            )}
          </SettingRow>
          {status === "success" && result?.hasUpdate && result.releaseUrl && (
            <SettingRow label={t("update.release_page")}>
              <a
                href={result.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground"
              >
                {t("update.open_on_github")}
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
              </a>
            </SettingRow>
          )}
        </div>
        {status === "error" && (
          <p className="px-1 pb-2 pt-1 text-xs text-muted-foreground">
            {t("update.check_failed_hint")}
          </p>
        )}
        {status === "success" && checkedAt && (
          <p className="px-1 pb-2 pt-1 text-xs text-muted-foreground/80">
            {t("update.checked_at", { time: formatTime(checkedAt) })}
          </p>
        )}
      </SectionCard>

      {/* 应用信息 */}
      <SectionCard
        icon={<Info className="size-4" strokeWidth={1.75} />}
        title={t("about.info")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow label={t("about.version")}>
            <span className="font-mono text-[13px] text-muted-foreground">
              {version}
            </span>
          </SettingRow>
          <SettingRow label={t("about.license")}>
            <span className="text-sm text-muted-foreground">GPL v2</span>
          </SettingRow>
          <SettingRow label={t("about.tech_stack")}>
            <span className="text-sm text-muted-foreground">{TECH_STACK}</span>
          </SettingRow>
        </div>
      </SectionCard>

      {/* 链接区 */}
      <SectionCard
        icon={<Link2 className="size-4" strokeWidth={1.75} />}
        title={t("about.links")}
        description={t("about.description")}
      >
        <div className="divide-y divide-border/50">
          {LINKS.map(({ key, href, icon: Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center gap-3 px-1 py-2.5 text-sm text-foreground transition-colors hover:bg-item-hover"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius)] bg-secondary/40 text-muted-foreground transition-colors group-hover:text-foreground">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t(`about.${key}`)}</span>
              <ExternalLink
                className="size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
                strokeWidth={1.75}
              />
            </a>
          ))}
        </div>
      </SectionCard>

      {/* 页脚 */}
      <p className="pb-1 text-center text-xs text-muted-foreground">
        {t("about.made_with")}
      </p>

      {/* 更新详情弹窗：发布说明 + 下载链接 */}
      <Modal>
        <Button className="hidden" aria-hidden />
        <Modal.Backdrop isOpen={detailOpen} onOpenChange={setDetailOpen}>
          <Modal.Container>
            <Modal.Dialog className="max-w-2xl">
              <Modal.Header>
                <Modal.Heading>
                  {t("update.details_title", {
                    version: result?.latestVersion ?? "",
                  })}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {result?.latestVersion && (
                      <span className="font-mono">{result.latestVersion}</span>
                    )}
                    {result?.publishedAt && (
                      <span>
                        {t("update.published_at", {
                          date: formatDate(result.publishedAt),
                        })}
                      </span>
                    )}
                  </div>

                  {releaseNotes ? (
                    <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-border/50 bg-card/40 p-4">
                      <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                        {releaseNotes}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("update.no_notes")}
                    </p>
                  )}

                  {result && result.assets.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold tracking-wider text-muted-foreground/80 uppercase">
                        {t("update.downloads")}
                      </div>
                      <div className="space-y-1.5">
                        {result.assets.map((asset) => (
                          <a
                            key={asset.url}
                            href={asset.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm text-foreground transition-colors hover:bg-item-hover"
                          >
                            <Download className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              {asset.name}
                            </span>
                            {asset.size > 0 && (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {formatBytes(asset.size)}
                              </span>
                            )}
                            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => setDetailOpen(false)}
                >
                  {t("update.close")}
                </Button>
                {result?.releaseUrl && (
                  <Button
                    size="sm"
                    variant="primary"
                    onPress={() =>
                      window.open(
                        result.releaseUrl,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    <ExternalLink className="size-4" />
                    {t("update.open_release")}
                  </Button>
                )}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
