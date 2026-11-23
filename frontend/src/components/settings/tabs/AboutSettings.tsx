import { useTranslation } from "react-i18next";
import { Bug, ExternalLink, Info, Link2, Sparkles } from "lucide-react";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";

const version =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const TECH_STACK = "React · TypeScript · Go · SQLite";

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

  return (
    <div className="space-y-5">
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
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                v{version}
              </span>
            </div>
            <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
              {t("about.tagline")}
            </p>
          </div>
        </div>
      </section>

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
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius)] bg-secondary/40 text-muted-foreground transition-colors group-hover:text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t(`about.${key}`)}</span>
              <ExternalLink
                className="size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-primary"
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
    </div>
  );
}
