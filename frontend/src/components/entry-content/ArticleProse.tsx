import { useCallback, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCodeHighlight } from "@/hooks/useCodeHighlight";
import { removeContentSeparators } from "@/lib/social-content";
import { useUISettingKey } from "@/hooks/useUISettings";
import { resolveReadingFontStack } from "@/lib/reading-fonts";
import { ArticleContent } from "@/components/ui/article-content";
import type { ArticleContentBlock } from "@/components/ui/article-content";
import { ArticleIframe } from "@/components/ui/article-iframe";
import { resolveIframeSrc } from "@/components/ui/article-iframe";
import { ArticleVideo } from "@/components/ui/article-video";
import { isDirectVideoUrl } from "@/lib/video-embed";
import { cn } from "@/lib/utils";

/**
 * 38 批：**正文页的排版管道**（字号 / 行高 / 阅读字体 / `removeContentSeparators` 规范化 /
 * 一整套 prose 覆盖类 / 代码高亮 / 外链箭头）。
 *
 * 原本这段只写在 `EntryContentBody` 里，而通知视图的时间线展开容器走的是另一个
 * 裸 `ArticleContent` + `prose-sm`（硬编码 14px / 24px），同一个条目在两个地方长得不一样
 * —— 用户报「通知视图下这个正文是个阉割版本」。
 *
 * 抽成组件是**同一份实现**而不是抄一份样式：第三栏正文页与时间线展开容器都渲染它，
 * 以后改排版只有一处要改，不会再漂回去。
 */
interface ArticleProseProps {
  content: string | null | undefined;
  /** 翻译后的分块内容（AI 翻译管道产出）；有就优先于 `content` */
  blocks?: ArticleContentBlock[] | null;
  /** 原文链接：外链「↗」小箭头靠它（`ArticleContent` 的 `articleUrl`） */
  articleUrl?: string;
  /** 代码高亮用的源文本（缺省用 `content`） */
  highlightContent?: string;
  /** 追加在 prose 类之后的 className（时间线展开容器传自己的边框/滚动/固定高度） */
  className?: string;
  /** 42-9：正文图片按容器宽自适应（社交视图开启，文章视图维持 prose 原样） */
  fitImages?: boolean;
  /**
   * 56-23：把正文容器（`data-slot="article-prose"` 这个 div）交出去。
   * 插件装饰要往这个容器的文本节点里包 `<mark>`、选中区间也相对它算 rune 偏移，
   * 所以上层拿到的必须是**这个**节点，而不是外层滚动容器或整篇文章（那会把标题、
   * AI 摘要、日期行都算进纯文本偏移里）。
   */
  bodyRef?: (node: HTMLDivElement | null) => void;
}

export function ArticleProse({
  content,
  blocks,
  articleUrl,
  highlightContent,
  className,
  fitImages = false,
  bodyRef,
}: ArticleProseProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  /** 代码高亮要 ref 对象、装饰/选中要节点本身：一个回调里同时交付，别挂两个 ref */
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      bodyRef?.(node);
    },
    [bodyRef],
  );
  const entryFontFamily = useUISettingKey("entryFontFamily");
  const entryFontSize = useUISettingKey("entryFontSize");
  const entryLineHeight = useUISettingKey("entryLineHeight");
  const iframeVideoHosts = useUISettingKey("iframeVideoHosts");
  const readingFontStack = resolveReadingFontStack(entryFontFamily);

  // 正文也走一遍规范化：去掉 <hr> 分隔线、把引文作者拆成单独一行
  const normalizedContent = useMemo(
    () => removeContentSeparators(content),
    [content],
  );
  useCodeHighlight(
    containerRef as RefObject<HTMLElement | null>,
    highlightContent ?? content ?? "",
  );

  const hasBlocks = !!blocks && blocks.length > 0;
  const hasContent =
    hasBlocks || (!!content && content.trim().length > 0);
  // 空正文兜底：RSSHub 的 YouTube 条目经常 content 为空（库里 80/80），只带 entry.url。
  // 与 Miniflux 的 add_youtube_video 规则等价：能从原文地址解析出「被改写过的播放器地址」时直接渲染。
  // 要求 resolved !== articleUrl，排除 bilibili 空间页、Wistia 原始页这类只能原样返回的地址，
  // 避免把整页塞进 16:9 iframe（多半被 X-Frame-Options 拒成黑块）。
  const resolvedEntryEmbed = !hasContent
    ? resolveIframeSrc(articleUrl, iframeVideoHosts)
    : null;
  const embedSrc =
    resolvedEntryEmbed && resolvedEntryEmbed !== articleUrl
      ? resolvedEntryEmbed
      : null;
  // 小站订阅常见：正文为空，但 entry.url 本身就是一个视频文件（.mp4/.webm/.m3u8…）。
  // 这种地址没法「内嵌 iframe」，直接用内置 Video.js 播放器播放。
  const entryDirectVideoSrc =
    !hasContent && !embedSrc && isDirectVideoUrl(articleUrl) ? articleUrl : null;

  return (
    <div
      ref={setContainer}
      style={{
        fontSize: `${entryFontSize}px`,
        lineHeight: entryLineHeight,
        // 排版细节：开启字距/连字微调与更优字形渲染（不改变字体家族）
        fontFeatureSettings: '"kern" 1, "liga" 1',
        textRendering: "optimizeLegibility",
        ...(readingFontStack ? { fontFamily: readingFontStack } : {}),
      }}
      className={cn(
        "prose dark:prose-invert max-w-none text-pretty hyphens-auto break-words reading-prose prose-img:!max-w-full prose-img:!h-auto prose-img:shadow-[0_4px_20px_rgba(0,0,0,0.08)] prose-video:!max-w-full prose-video:!h-auto prose-video:shadow-[0_4px_20px_rgba(0,0,0,0.08)] prose-figure:!max-w-full prose-a:underline prose-a:decoration-primary/30 prose-a:underline-offset-[3px] prose-a:break-words prose-blockquote:not-italic prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 prose-blockquote:bg-transparent prose-blockquote:text-foreground/85 prose-blockquote:py-1 prose-blockquote:pl-5 prose-blockquote:ml-0 prose-blockquote:rounded-none prose-th:bg-secondary/60 prose-code:bg-secondary/60 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:break-all prose-code:before:content-none prose-code:after:content-none prose-pre:p-0 prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:overflow-hidden",
        className,
      )}
      data-slot="article-prose"
    >
      {hasContent ? (
        hasBlocks ? (
          <ArticleContent
            blocks={blocks ?? []}
            articleUrl={articleUrl}
            fitImages={fitImages}
          />
        ) : (
          <ArticleContent
            content={normalizedContent ?? ""}
            articleUrl={articleUrl}
            fitImages={fitImages}
          />
        )
      ) : embedSrc ? (
        <ArticleIframe src={embedSrc} />
      ) : entryDirectVideoSrc ? (
        <ArticleVideo src={entryDirectVideoSrc} />
      ) : (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("entry.no_content")}
        </div>
      )}
    </div>
  );
}