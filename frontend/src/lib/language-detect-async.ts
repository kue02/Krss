type LanguageDetectModule = typeof import("./language-detect");

let languageDetectModulePromise: Promise<LanguageDetectModule> | null = null;

async function getLanguageDetectModule() {
  if (!languageDetectModulePromise) {
    languageDetectModulePromise = import("./language-detect");
  }
  return languageDetectModulePromise;
}

export async function detectLanguage(text: string): Promise<string | null> {
  const module = await getLanguageDetectModule();
  return module.detectLanguage(text);
}

export async function isTargetLanguage(
  text: string,
  targetLanguage: string,
): Promise<boolean> {
  const module = await getLanguageDetectModule();
  return module.isTargetLanguage(text, targetLanguage);
}

export async function needsTranslation(
  title: string,
  summary: string | null,
  targetLanguage: string,
): Promise<boolean> {
  const module = await getLanguageDetectModule();
  return module.needsTranslation(title, summary, targetLanguage);
}

/**
 * 54-10：列表标题/摘要**逐字段**判定（见 `language-detect.ts` 里 `needsListTranslation`
 * 的口径说明）。列表里标题和摘要语言可以不一样，不能复用 `needsTranslation`
 * （那个是「这条要不要翻正文」）。
 */
export async function needsListTranslation(
  title: string | null | undefined,
  summary: string | null | undefined,
  targetLanguage: string,
): Promise<boolean> {
  const module = await getLanguageDetectModule();
  return module.needsListTranslation(title, summary, targetLanguage);
}
