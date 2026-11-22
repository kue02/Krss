import { create } from "zustand";

export interface ArticleTranslation {
  title: string | null;
  summary: string | null;
  content: string | null;
}

/**
 * REQ3：翻译 / 摘要的**过程状态**（与内容缓存分开存，避免污染 `data`）。
 * 存进 `statuses[`${entryId}:${language}`]`；`content` 对应正文翻译、`summary` 对应 AI 摘要。
 */
export type TranslationStatusState = "translating" | "done" | "failed";

export interface TranslationStatusEntry {
  state: TranslationStatusState;
  error?: string;
  /** 翻译/摘要实际使用的服务名（如「Google 翻译」/模型名），供徽章悬停展示。 */
  service?: string;
  /** 服务提供商。 */
  provider?: string;
  /** 走模型时的模型名。 */
  model?: string;
}

/** AI 摘要状态（与「翻译」分开存；列表卡片据此显示摘要徽章）。 */
export interface AISummaryStatusEntry {
  state: TranslationStatusState;
  error?: string;
  provider?: string;
  model?: string;
}

export interface EntryTranslationStatus {
  content?: TranslationStatusEntry;
  summary?: TranslationStatusEntry;
}

export interface TranslationStatusPatch {
  content?: TranslationStatusEntry | null;
  summary?: TranslationStatusEntry | null;
}

// Helper to create cache key that includes readability mode
function getCacheKey(language: string, isReadability: boolean): string {
  return isReadability ? `${language}:readability` : language;
}

interface TranslationState {
  // data[articleId][cacheKey] = translation
  // cacheKey = language or language:readability
  data: Record<string, Record<string, ArticleTranslation>>;
  // Articles where user manually disabled translation
  disabled: Set<string>;
  // REQ3：过程状态，key = `${entryId}:${language}`
  statuses: Record<string, EntryTranslationStatus>;
  // AI 摘要状态，key = `${entryId}:${language}`（与翻译分开）
  aiSummaryStatuses: Record<string, AISummaryStatusEntry>;

  // Actions
  getTranslation: (
    articleId: string,
    language: string,
    isReadability?: boolean,
  ) => ArticleTranslation | undefined;
  setTranslation: (
    articleId: string,
    language: string,
    translation: Partial<ArticleTranslation>,
    isReadability?: boolean,
  ) => void;
  clearTranslation: (articleId: string) => void;
  disableTranslation: (articleId: string) => void;
  enableTranslation: (articleId: string) => void;
  isDisabled: (articleId: string) => boolean;
  /** REQ3：读某个条目某语言的翻译 / 摘要过程状态 */
  getStatus: (
    articleId: string,
    language: string,
  ) => EntryTranslationStatus | undefined;
  /** REQ3：更新过程状态（浅合并 content / summary；传 null 删除对应字段） */
  setStatus: (
    articleId: string,
    language: string,
    patch: TranslationStatusPatch,
  ) => void;
  /** REQ3：清状态（不传 language 则清该条目所有语言） */
  clearStatus: (articleId: string, language?: string) => void;
  /** 读某条目某语言的 AI 摘要状态 */
  getSummaryStatus: (
    articleId: string,
    language: string,
  ) => AISummaryStatusEntry | undefined;
  /** 写/覆盖 AI 摘要状态（传 null 删除） */
  setSummaryStatus: (
    articleId: string,
    language: string,
    value: AISummaryStatusEntry | null,
  ) => void;
}

export const useTranslationStore = create<TranslationState>((set, get) => ({
  data: {},
  disabled: new Set<string>(),
  statuses: {},
  aiSummaryStatuses: {},

  getTranslation: (
    articleId: string,
    language: string,
    isReadability = false,
  ) => {
    // Return undefined if translation is disabled for this article
    if (get().disabled.has(articleId)) return undefined;
    const key = getCacheKey(language, isReadability);
    return get().data[articleId]?.[key];
  },

  setTranslation: (
    articleId: string,
    language: string,
    translation: Partial<ArticleTranslation>,
    isReadability = false,
  ) => {
    const key = getCacheKey(language, isReadability);
    set((state) => {
      const articleData = state.data[articleId] ?? {};
      const existingTranslation = articleData[key] ?? {
        title: null,
        summary: null,
        content: null,
      };

      return {
        data: {
          ...state.data,
          [articleId]: {
            ...articleData,
            [key]: {
              ...existingTranslation,
              ...translation,
            },
          },
        },
      };
    });
  },

  clearTranslation: (articleId: string) => {
    set((state) => {
      const { [articleId]: _removed, ...rest } = state.data;
      void _removed;
      const statuses = { ...state.statuses };
      const aiSummaryStatuses = { ...state.aiSummaryStatuses };
      const prefix = `${articleId}:`;
      for (const key of Object.keys(statuses)) {
        if (key.startsWith(prefix)) delete statuses[key];
      }
      for (const key of Object.keys(aiSummaryStatuses)) {
        if (key.startsWith(prefix)) delete aiSummaryStatuses[key];
      }
      return { data: rest, statuses, aiSummaryStatuses };
    });
  },

  disableTranslation: (articleId: string) => {
    set((state) => {
      const newDisabled = new Set(state.disabled);
      newDisabled.add(articleId);
      // Also clear existing translation data
      const { [articleId]: _removed, ...rest } = state.data;
      void _removed;
      // REQ3：停用后清掉该条目的过程状态，免得卡片继续显示「翻译中 / 失败」
      const statuses = { ...state.statuses };
      const aiSummaryStatuses = { ...state.aiSummaryStatuses };
      const prefix = `${articleId}:`;
      for (const key of Object.keys(statuses)) {
        if (key.startsWith(prefix)) delete statuses[key];
      }
      for (const key of Object.keys(aiSummaryStatuses)) {
        if (key.startsWith(prefix)) delete aiSummaryStatuses[key];
      }
      return { disabled: newDisabled, data: rest, statuses, aiSummaryStatuses };
    });
  },

  enableTranslation: (articleId: string) => {
    set((state) => {
      const newDisabled = new Set(state.disabled);
      newDisabled.delete(articleId);
      return { disabled: newDisabled };
    });
  },

  isDisabled: (articleId: string) => {
    return get().disabled.has(articleId);
  },

  getStatus: (articleId: string, language: string) => {
    return get().statuses[`${articleId}:${language}`];
  },

  setStatus: (
    articleId: string,
    language: string,
    patch: TranslationStatusPatch,
  ) => {
    const key = `${articleId}:${language}`;
    set((state) => {
      const existing = state.statuses[key] ?? {};
      const next: EntryTranslationStatus = { ...existing };
      (["content", "summary"] as const).forEach((field) => {
        const value = patch[field];
        if (value === undefined) return;
        if (value === null) {
          delete next[field];
        } else {
          next[field] = value;
        }
      });
      const statuses = { ...state.statuses };
      if (!next.content && !next.summary) {
        delete statuses[key];
      } else {
        statuses[key] = next;
      }
      return { statuses };
    });
  },

  clearStatus: (articleId: string, language?: string) => {
    set((state) => {
      const statuses = { ...state.statuses };
      if (language) {
        delete statuses[`${articleId}:${language}`];
      } else {
        const prefix = `${articleId}:`;
        for (const key of Object.keys(statuses)) {
          if (key.startsWith(prefix)) delete statuses[key];
        }
      }
      return { statuses };
    });
  },

  getSummaryStatus: (articleId: string, language: string) => {
    return get().aiSummaryStatuses[`${articleId}:${language}`];
  },

  setSummaryStatus: (
    articleId: string,
    language: string,
    value: AISummaryStatusEntry | null,
  ) => {
    const key = `${articleId}:${language}`;
    set((state) => {
      const aiSummaryStatuses = { ...state.aiSummaryStatuses };
      if (value === null) {
        delete aiSummaryStatuses[key];
      } else {
        aiSummaryStatuses[key] = value;
      }
      return { aiSummaryStatuses };
    });
  },
}));

// Helper for external use
export { getCacheKey };

// Actions for external use (outside React components)
// Use dynamic getState() to avoid stale references
export const translationActions = {
  get: (articleId: string, language: string, isReadability?: boolean) =>
    useTranslationStore
      .getState()
      .getTranslation(articleId, language, isReadability),
  set: (
    articleId: string,
    language: string,
    translation: Partial<ArticleTranslation>,
    isReadability?: boolean,
  ) =>
    useTranslationStore
      .getState()
      .setTranslation(articleId, language, translation, isReadability),
  clear: (articleId: string) =>
    useTranslationStore.getState().clearTranslation(articleId),
  disable: (articleId: string) =>
    useTranslationStore.getState().disableTranslation(articleId),
  enable: (articleId: string) =>
    useTranslationStore.getState().enableTranslation(articleId),
  isDisabled: (articleId: string) =>
    useTranslationStore.getState().isDisabled(articleId),
  getStatus: (articleId: string, language: string) =>
    useTranslationStore.getState().getStatus(articleId, language),
  setStatus: (
    articleId: string,
    language: string,
    patch: TranslationStatusPatch,
  ) =>
    useTranslationStore.getState().setStatus(articleId, language, patch),
  clearStatus: (articleId: string, language?: string) =>
    useTranslationStore.getState().clearStatus(articleId, language),
  getSummaryStatus: (articleId: string, language: string) =>
    useTranslationStore.getState().getSummaryStatus(articleId, language),
  setSummaryStatus: (
    articleId: string,
    language: string,
    value: AISummaryStatusEntry | null,
  ) => useTranslationStore.getState().setSummaryStatus(articleId, language, value),
};
