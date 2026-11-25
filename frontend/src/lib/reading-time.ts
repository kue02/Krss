/** 估算阅读时长（分钟）：中英混排按 230 字/词/分钟。无内容返回 null。 */
export function estimateReadingMinutes(content: string | null | undefined): number | null {
  if (!content) return null;
  const text = content.replace(/<[^>]*>/g, "");
  const words = text.match(/[\u4e00-\u9fa5]|\w+/g)?.length || 0;
  const mins = Math.ceil(words / 230);
  return mins > 0 ? mins : null;
}
