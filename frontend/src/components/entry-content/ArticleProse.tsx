import { useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCodeHighlight } from "@/hooks/useCodeHighlight";
import { removeContentSeparators } from "@/lib/social-content";
import { useUISettingKey } from "@/hooks/useUISettings";
import { resolveReadingFontStack } from "@/lib/reading-fonts";
import { ArticleContent } from "@/components/ui/article-content";
import type { ArticleContentBlock } from "@/components/ui/article-content";
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
}

export function ArticleProse({
  content,
  blocks,
  articleUrl,
  highlightContent,
  className,
}: ArticleProseProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const entryFontFamily = useUISettingKey("entryFontFamily");
  const entryFontSize = useUISettingKey("entryFontSize");
  const entryLineHeight = useUISettingKey("entryLineHeight");
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

  return (
    <div
      ref={containerRef}
      style={{
        fontSize: `${entryFontSize}px`,
        lineHeight: entryLineHeight,
        ...(readingFontStack ? { fontFamily: readingFontStack } : {}),
      }}
      className={cn(
        "prose dark:prose-invert max-w-none hyphens-auto break-words reading-prose prose-img:!max-w-full prose-img:!h-auto prose-img:shadow-[0_4px_20px_rgba(0,0,0,0.08)] prose-video:!max-w-full prose-video:!h-auto prose-video:shadow-[0_4px_20px_rgba(0,0,0,0.08)] prose-figure:!max-w-full prose-a:underline prose-a:decoration-primary/30 prose-a:underline-offset-[3px] prose-a:break-words prose-blockquote:not-italic prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 prose-blockquote:bg-transparent prose-blockquote:text-foreground/85 prose-blockquote:py-1 prose-blockquote:pl-5 prose-blockquote:ml-0 prose-blockquote:rounded-none prose-th:bg-secondary/60 prose-code:bg-secondary/60 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:break-all prose-code:before:content-none prose-code:after:content-none prose-pre:p-0 prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:overflow-hidden",
        className,
      )}
      data-slot="article-prose"
    >
      {hasContent ? (
        hasBlocks ? (
          <ArticleContent blocks={blocks ?? []} articleUrl={articleUrl} />
        ) : (
          <ArticleContent
            content={normalizedContent ?? ""}
            articleUrl={articleUrl}
          />
        )
      ) : (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("entry.no_content")}
        </div>
      )}
    </div>
  );
}