/**
 * 正文翻译的**在途登记表**（同一条目 / 同一模式 / 同一目标语言 = 同一个 key）。
 *
 * 为什么需要：预载（`useEntryPrefetch`）与打开路径（`useAITranslation`）会**各自**发起
 * `streamTranslateBlocks`。用户点得比预载快时，同一条内容会被跑两遍模型 ——
 * 实测（本地 Hy-MT2-1.8B 串行）3 条并发要 ~2.5 分钟，重复那次足以把「打开即出」变成
 * 「打开再等一遍」。摘要没这个问题：预载只把摘要落进后端缓存，打开时的第二次请求
 * 走的是 `{cached:true}`（一次往返，不再跑模型），所以这里只管翻译。
 *
 * 用法（两边对称，谁先来谁当发起方）：
 * - 发起方：`claimContentTranslation(...)` 拿到 claim（拿不到 = 已经有人在翻，**别发**），
 *   每收到一个流事件 `claim.emit(event)`，并在 `finally` 里 `claim.finish()`。
 * - 订阅方：`attachContentTranslation(..., listener)` 拿到完成承诺（拿不到 = 没有在途，
 *   自己发）；订阅方按与本地流**完全相同**的方式处理转发来的事件 ⇒ 打开时照样逐块出。
 *
 * 硬约束：**发起方必须 finish**（成功 / 失败 / 被 abort 都要）。漏掉的话，订阅方会一直
 * 等在「翻译中」，`finish()` 是唯一的解绑入口。
 */
import type { TranslateEvent } from "@/api";

/** 流事件，外加「命中后端缓存」那一种（与 `streamTranslateBlocks` 的产出同形） */
export type ContentTranslationEvent =
  | TranslateEvent
  | { cached: true; content: string };

export interface ContentTranslationClaim {
  /** 把流事件转发给所有订阅者（订阅方抛错不影响发起方） */
  emit: (event: ContentTranslationEvent) => void;
  /** 收尾：唤醒等着的订阅方并从登记表摘掉自己 */
  finish: () => void;
  /** 发起方自己的完成信号（订阅方拿到的是同一个） */
  readonly done: Promise<void>;
}

interface InFlightEntry {
  listeners: Set<(event: ContentTranslationEvent) => void>;
  finish: () => void;
  done: Promise<void>;
}

const inFlight = new Map<string, InFlightEntry>();

/** 同一个 key 才算「同一次翻译」：换模式（阅读模式/原文）或换目标语言都是另一次 */
export function contentTranslationKey(
  entryId: string,
  isReadability: boolean,
  language: string,
): string {
  return `${entryId}|${isReadability ? "readability" : "raw"}|${language}`;
}

/** 有没有在跑的（发起前问一句，或用它写断言） */
export function isContentTranslationInFlight(
  entryId: string,
  isReadability: boolean,
  language: string,
): boolean {
  return inFlight.has(contentTranslationKey(entryId, isReadability, language));
}

/**
 * 声明「这条我来发」。已经有在途的 ⇒ 返回 `null`（**调用方必须真的不要发请求**）。
 */
export function claimContentTranslation(
  entryId: string,
  isReadability: boolean,
  language: string,
): ContentTranslationClaim | null {
  const key = contentTranslationKey(entryId, isReadability, language);
  if (inFlight.has(key)) return null;

  const listeners = new Set<(event: ContentTranslationEvent) => void>();
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const entry: InFlightEntry = {
    listeners,
    done,
    finish: () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
      resolveDone();
      listeners.clear();
    },
  };
  inFlight.set(key, entry);

  return {
    done,
    emit: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // 订阅方自己的错误不该打断正在跑的翻译
        }
      }
    },
    finish: entry.finish,
  };
}

/**
 * 订阅在途的那次翻译。返回「它什么时候结束」的承诺；**没有在途则返回 `null`**
 * （调用方据此决定自己发请求）。
 */
export function attachContentTranslation(
  entryId: string,
  isReadability: boolean,
  language: string,
  listener: (event: ContentTranslationEvent) => void,
): Promise<void> | null {
  const entry = inFlight.get(
    contentTranslationKey(entryId, isReadability, language),
  );
  if (!entry) return null;
  entry.listeners.add(listener);
  return entry.done.then(() => {
    entry.listeners.delete(listener);
  });
}

/** 仅测试用：清空登记表（避免用例之间互相影响） */
export function resetContentTranslationInFlight(): void {
  inFlight.clear();
}
