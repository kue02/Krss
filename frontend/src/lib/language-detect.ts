import { eld } from "eld/small";
import { stripHtml } from "./html-utils";

/**
 * Language detection using ELD (Efficient Language Detector)
 * Returns ISO 639-1 codes (zh, en, ja, etc.)
 */

// Map target language codes to ISO 639-1 codes
const TARGET_TO_ISO: Record<string, string> = {
  "zh-CN": "zh",
  "zh-TW": "zh",
  "en-US": "en",
  en: "en",
  ja: "ja",
  ko: "ko",
  fr: "fr",
  de: "de",
  es: "es",
  ru: "ru",
  ar: "ar",
  pt: "pt",
  it: "it",
};

/**
 * Clean text for language detection by removing HTML and URLs
 */
function cleanTextForDetection(text: string): string {
  return stripHtml(text)
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

/**
 * Detect the language of text
 * Returns ISO 639-1 code or null if uncertain
 */
export function detectLanguage(text: string): string | null {
  if (!text || text.length < 10) return null;

  const cleanText = cleanTextForDetection(text);
  if (cleanText.length < 10) return null;

  const result = eld.detect(cleanText);

  // Return null if language is undetermined or unreliable
  if (!result.language || !result.isReliable()) {
    return null;
  }

  return result.language;
}

/**
 * Get normalized ISO 639-1 code from target language code
 */
export function getTargetLanguageCode(targetLanguage: string): string {
  return TARGET_TO_ISO[targetLanguage] || targetLanguage;
}

/**
 * Check if text is already in the target language
 */
export function isTargetLanguage(
  text: string,
  targetLanguage: string,
): boolean {
  const detected = detectLanguage(text);
  if (!detected) return false;

  const targetCode = getTargetLanguageCode(targetLanguage);
  return detected === targetCode;
}

/**
 * Check if an article needs translation based on title and summary
 * Priority: content language > title language
 */
export function needsTranslation(
  title: string,
  summary: string | null,
  targetLanguage: string,
): boolean {
  const targetCode = getTargetLanguageCode(targetLanguage);

  // 1. Priority: Check content language (if available and sufficient)
  if (summary) {
    const cleanSummary = cleanTextForDetection(summary);

    if (cleanSummary.length >= 20) {
      const result = eld.detect(cleanSummary);

      // Content matches target language -> no translation needed
      if (result.language === targetCode) {
        return false;
      }

      // Content reliably detected as different language -> needs translation
      if (result.isReliable()) {
        return true;
      }
    }
  }

  // 2. Fallback: Check title language (if content is insufficient or unreliable)
  if (title) {
    const cleanTitle = cleanTextForDetection(title);

    if (cleanTitle.length >= 10) {
      const result = eld.detect(cleanTitle);

      // Title matches target language -> no translation needed
      if (result.language === targetCode) {
        return false;
      }
    }
  }

  // 3. Default: Assume needs translation if unable to determine
  return true;
}

/**
 * 列表标题/摘要**各自**要不要翻（54-10）。
 *
 * 为什么不能复用 `needsTranslation`：那个函数回答的是「这**条**要不要翻正文」，
 * 口径是「正文语言优先，正文够了就一票定生死」。而列表里的标题和摘要来自
 * **两个不同的字段**，语言可以不一样 —— 典型就是社交帖：
 * 正文已经被源站翻成中文了，标题却还是英文原文。用旧口径判 ⇒ 正文中文
 * ⇒ 整体 `false` ⇒ 标题永远不翻，用户看到「中文正文 + 英文标题」。
 *
 * 这里改成**逐字段独立判定**：标题按标题的语言判、摘要按摘要的语言判，
 * 两者互不影响。任一字段需要翻，就返回 true（调用方会把两个字段都送去翻，
 * 后端只对确实不同的语言产出结果）。
 */
export function needsFieldTranslation(
  text: string | null | undefined,
  targetLanguage: string,
): boolean {
  if (!text) return false;
  const clean = cleanTextForDetection(text);
  // 太短的内容检测不可靠（「好的」「NB」这类）—— 判「不用翻」，免得白跑一趟模型
  if (clean.length < 6) return false;

  const detected = detectLanguage(clean);
  if (!detected) return false; // 判不出来就别折腾（保持原文）
  return detected !== getTargetLanguageCode(targetLanguage);
}

/**
 * 列表一条条目里，**标题或摘要**是否有需要翻的（54-10）。
 *
 * - 标题是外文 ⇒ 要翻（这是用户在社媒视图里看到的那行标题）
 * - 摘要（= 正文前 200 字）是外文 ⇒ 要翻（文章视图卡片摘要用）
 * - 两者都是目标语言 ⇒ 不用翻（省一次批量请求）
 */
export function needsListTranslation(
  title: string | null | undefined,
  summary: string | null | undefined,
  targetLanguage: string,
): boolean {
  return (
    needsFieldTranslation(title, targetLanguage) ||
    needsFieldTranslation(summary, targetLanguage)
  );
}
