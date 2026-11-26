import { createElement, useMemo } from "react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Accordion, Button, Chip, Modal } from "@heroui/react";
import type { Components } from "hast-util-to-jsx-runtime";
import { Download, ExternalLink } from "lucide-react";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import { parseHtml } from "@/lib/parse-html";
import type { UpdateRelease } from "@/types/settings";

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

/**
 * 发布说明里的链接一律开新标签：这是应用内的弹窗，直接导航走用户就回不到应用了。
 * `components` 只喂给 toJsxRuntime，不进 unified 管线（见 lib/parse-html.ts 注释）。
 */
const RELEASE_NOTE_COMPONENTS: Components = {
  // node 是 hast 的元信息，DOM 属性里不能出现，丢掉
  a: ({ node: _node, ...props }) =>
    createElement("a", {
      ...(props as ComponentProps<"a">),
      target: "_blank",
      rel: "noopener noreferrer",
    }),
};

function ReleaseNotes({ html }: { html: string }) {
  const { t } = useTranslation();

  const content = useMemo(() => {
    if (!html) return null;
    try {
      return parseHtml(html, { components: RELEASE_NOTE_COMPONENTS }).toContent();
    } catch {
      return null;
    }
  }, [html]);

  if (!content) {
    return (
      <p className="text-sm text-muted-foreground">{t("update.no_notes")}</p>
    );
  }
  return (
    <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
      {content}
    </div>
  );
}

function ReleaseAssets({ release }: { release: UpdateRelease }) {
  const { t } = useTranslation();
  if (release.assets.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      <div className="text-xs font-semibold tracking-wider text-muted-foreground/80 uppercase">
        {t("update.downloads")}
      </div>
      {release.assets.map((asset) => (
        <a
          key={`${asset.name}::${asset.url}`}
          href={asset.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm text-foreground transition-colors hover:bg-item-hover"
        >
          <Download className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{asset.name}</span>
          {asset.size > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatBytes(asset.size)}
            </span>
          )}
          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
        </a>
      ))}
    </div>
  );
}

/**
 * 版本更新详情：列出**当前版本之后的所有** Release，而不是只列最新那一版。
 *
 * 弹窗挂在 App 的已登录层（不是「关于」页内部）：右下角提示点「查看更新内容」
 * 要能直接打开它，那时设置弹窗可能压根没开，「关于」页也就不在 DOM 里。
 */
export function UpdateDetailsDialog() {
  const { t } = useTranslation();
  const result = useUpdateCheckStore((state) => state.result);
  const detailOpen = useUpdateCheckStore((state) => state.detailOpen);
  const setDetailOpen = useUpdateCheckStore((state) => state.setDetailOpen);

  const releases = result?.releases ?? [];
  const currentVersion = result?.currentVersion ?? "";
  const latest = releases[0] ?? null;
  // 只有一版时沿用「版本 vX 更新内容」；多版改成数量口径，否则标题会谎报只更新了最新一版。
  // 一版都没有时不拼「版本  更新内容」（会出现两个空格），退回中性标题。
  const title =
    releases.length === 0
      ? t("update.check_title")
      : releases.length > 1
        ? t("update.details_title_count", { count: releases.length })
        : t("update.details_title", { version: latest?.version ?? "" });

  return (
    <Modal>
      <Button className="hidden" aria-hidden />
      <Modal.Backdrop isOpen={detailOpen} onOpenChange={setDetailOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-2xl">
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              {currentVersion && (
                <p className="text-xs text-muted-foreground">
                  {t("update.details_since", { version: currentVersion })}
                </p>
              )}
            </Modal.Header>
            <Modal.Body>
              {releases.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("update.no_releases")}
                </p>
              ) : (
              <div className="max-h-[52vh] overflow-y-auto rounded-xl border border-border/50 bg-card/40">
                <Accordion.Root
                  allowsMultipleExpanded
                  defaultExpandedKeys={
                    latest ? [latest.version] : ([] as string[])
                  }
                >
                  {releases.map((release, index) => (
                    <Accordion.Item key={release.version} id={release.version}>
                      <Accordion.Heading>
                        <Accordion.Trigger>
                          <span className="flex min-w-0 flex-1 flex-col gap-1 text-start">
                            <span className="flex flex-wrap items-center gap-2">
                              <Chip
                                size="sm"
                                className="font-mono font-semibold"
                              >
                                {release.version}
                              </Chip>
                              {index === 0 && (
                                <Chip
                                  size="sm"
                                  color="warning"
                                  variant="soft"
                                  className="text-foreground"
                                >
                                  {t("update.latest_version")}
                                </Chip>
                              )}
                              {release.name && release.name !== release.version && (
                                <span className="truncate text-xs font-normal text-muted-foreground">
                                  {release.name}
                                </span>
                              )}
                            </span>
                            {release.publishedAt && (
                              <span className="text-xs font-normal text-muted-foreground">
                                {t("update.published_at", {
                                  date: formatDate(release.publishedAt),
                                })}
                              </span>
                            )}
                          </span>
                          <Accordion.Indicator className="ms-3" />
                        </Accordion.Trigger>
                      </Accordion.Heading>
                      <Accordion.Panel>
                        <Accordion.Body>
                          <ReleaseNotes html={release.notesHtml} />
                          <ReleaseAssets release={release} />
                        </Accordion.Body>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion.Root>
              </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                size="sm"
                variant="outline"
                onPress={() => setDetailOpen(false)}
              >
                {t("update.close")}
              </Button>
              {latest?.url && (
                // 同横幅：primary 在暗色下是黑底黑字（与弹窗背景对比度仅 1.19:1），
                // 用 foreground 反色保证两套主题都够亮。
                <Button
                  size="sm"
                  className="border border-foreground bg-foreground text-background shadow-none hover:bg-foreground/90"
                  onPress={() =>
                    window.open(latest.url, "_blank", "noopener,noreferrer")
                  }
                >
                  <ExternalLink className="size-4" />
                  {t("update.open_release")}
                </Button>
              )}
            </Modal.Footer>
            <Modal.CloseTrigger />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
