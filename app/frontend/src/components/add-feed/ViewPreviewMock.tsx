import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ContentType } from "@/types/api";

interface ViewPreviewMockProps {
  type: ContentType;
  /** 用订阅标题当样例文字，让预览更像真实内容 */
  sampleTitle: string;
}

/**
 * 选视图时给一个小样：让用户直观看到「这个源放进这个视图会长什么样」。
 * 只是静态示意，纯占位色块（不请求任何数据）。
 */
export function ViewPreviewMock({ type, sampleTitle }: ViewPreviewMockProps) {
  const { t } = useTranslation();

  const bar = (width: string, key: string, opacity = "bg-muted-foreground/25") => (
    <span key={key} className={cn("block h-2 rounded-full", opacity)} style={{ width }} />
  );

  return (
    <div className="rounded-xl border border-border bg-surface/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t(`content_type.${type}`)}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {t("add_feed.view_preview_hint")}
        </span>
      </div>

      {type === "article" && (
        <div className="flex gap-3 rounded-lg bg-background p-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="truncate text-xs font-semibold text-foreground">
              {sampleTitle}
            </div>
            {bar("100%", "a")}
            {bar("86%", "b")}
            {bar("62%", "c")}
          </div>
          <div className="size-12 shrink-0 rounded-md bg-muted-foreground/20" />
        </div>
      )}

      {type === "picture" && (
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div
              key={index}
              className={cn(
                "rounded-md bg-muted-foreground/20",
                index % 3 === 1 ? "h-16" : "h-12",
              )}
            />
          ))}
        </div>
      )}

      {type === "notification" && (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="truncate text-[11px] text-foreground/80">
                  {index === 0 ? sampleTitle : t("add_feed.sample_notification")}
                </div>
                {bar("72%", `n${index}`)}
              </div>
            </div>
          ))}
        </div>
      )}

      {type === "social" && (
        <div className="space-y-3">
          {[0, 1].map((index) => (
            <div key={index} className="flex gap-2.5">
              <div className="size-6 shrink-0 rounded-full bg-muted-foreground/25" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate text-foreground/80">
                    {t("add_feed.sample_author")}
                  </span>
                  <span className="truncate">@handle</span>
                  <span>·</span>
                  <span>3h</span>
                </div>
                {bar("96%", `s${index}a`, "bg-muted-foreground/30")}
                {bar("74%", `s${index}b`, "bg-muted-foreground/30")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
