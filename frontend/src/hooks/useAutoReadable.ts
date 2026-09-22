import { useEffect, useState } from "react";
import { fetchReadableContent } from "@/api";
import { stripHtml } from "@/lib/html-utils";
import { looksLikeJunkContent } from "@/lib/readable-quality";
import type { Entry } from "@/types/api";

/** 正文短于这个长度就认为「源只给了摘要」，必要时去抓正文 */
const MIN_CONTENT_CHARS = 400;

/** 已经抓过的条目（含进行中），避免滚出滚回视口时重复抓同一个条目 */
const requestedIds = new Set<string>();

/**
 * 社交媒体视图里按需补全正文。
 *
 * 不少源只在 feed 里放摘要 + 「查看全文」链接；Folo 式信息流要的是全文，
 * 所以这里在正文过短时调用后端 `POST /api/entries/:id/fetch-readable` 抓一次。
 * 默认关闭（设置 → 外观 → 按视图 → 缺全文时自动抓取），开启后也只对进入视口的条目触发。
 */
export function useAutoReadable(
  entry: Entry,
  enabled: boolean,
): string | null {
  const [content, setContent] = useState<string | null>(null);

  const plainLength = entry.content ? stripHtml(entry.content).length : 0;

  useEffect(() => {
    if (!enabled) return;

    // 后端已经抓过就直接用——但要先过质量校验：
    // 实测对 X 这类社交链接抓回的是未登录落地页，宁可不用
    if (entry.readableContent) {
      if (!looksLikeJunkContent(entry.readableContent)) {
        setContent(entry.readableContent);
      }
      return;
    }

    if (plainLength >= MIN_CONTENT_CHARS) return;
    if (requestedIds.has(entry.id)) return;
    requestedIds.add(entry.id);

    let cancelled = false;
    fetchReadableContent(entry.id)
      .then((html) => {
        if (cancelled || !html) return;
        // 抓回登录墙/付费墙/验证页就丢掉，保留源内容
        if (looksLikeJunkContent(html)) return;
        setContent(html);
      })
      .catch(() => {
        // 抓取失败就退回 feed 原始内容，不打扰用户；同时放开标记允许下次重试
        requestedIds.delete(entry.id);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, entry.id, entry.readableContent, plainLength]);

  return content;
}
