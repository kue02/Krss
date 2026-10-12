import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { useAITranslation } from "./useAITranslation";
import { dismissToast, useToasts } from "@/stores/toast-store";

const {
  mockStreamTranslateBlocks,
  mockNeedsTranslation,
  mockTranslateArticlesBatch,
  mockStoreGetTranslation,
  mockTranslationActionsSet,
  mockTranslationActionsDisable,
  mockTranslationActionsEnable,
  mockTranslationActionsIsDisabled,
} = vi.hoisted(() => ({
  mockStreamTranslateBlocks: vi.fn(),
  mockNeedsTranslation: vi.fn(),
  mockTranslateArticlesBatch: vi.fn(() => Promise.resolve()),
  mockStoreGetTranslation: vi.fn(),
  mockTranslationActionsSet: vi.fn(),
  mockTranslationActionsDisable: vi.fn(),
  mockTranslationActionsEnable: vi.fn(),
  mockTranslationActionsIsDisabled: vi.fn(() => false),
}));

vi.mock("@/api", () => ({
  streamTranslateBlocks: mockStreamTranslateBlocks,
  isTranslateInit: (event: unknown) =>
    typeof event === "object" && event !== null && "blocks" in event,
  isTranslateBlockResult: (event: unknown) =>
    typeof event === "object" &&
    event !== null &&
    "index" in event &&
    "html" in event &&
    !("blocks" in event),
  isTranslateDone: (event: unknown) =>
    typeof event === "object" && event !== null && "done" in event,
  isTranslateError: (event: unknown) =>
    typeof event === "object" && event !== null && "error" in event,
}));

vi.mock("@/lib/language-detect", () => ({
  needsTranslation: mockNeedsTranslation,
}));

vi.mock("@/lib/html-utils", () => ({
  stripHtml: (html: string) => html.replace(/<[^>]*>/g, ""),
}));

vi.mock("@/services/translation-service", () => ({
  translateArticlesBatch: mockTranslateArticlesBatch,
}));

vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: (
    selector: (state: {
      getTranslation: typeof mockStoreGetTranslation;
    }) => unknown,
  ) =>
    selector({
      getTranslation: mockStoreGetTranslation,
    }),
  translationActions: {
    set: mockTranslationActionsSet,
    disable: mockTranslationActionsDisable,
    enable: mockTranslationActionsEnable,
    isDisabled: mockTranslationActionsIsDisabled,
  },
}));

function createEntry(content: string): Entry {
  return {
    id: "entry-1",
    feedId: "feed-1",
    title: "Test title",
    content,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function createAbortAwarePendingStream(
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  return (async function* () {
    await new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(createAbortError()), {
        once: true,
      });
    });
    // Unreachable in normal flow; keeps generator shape explicit for lint rule.
    yield { done: true };
  })();
}

function createDeferredCachedStream(content: string): {
  stream: AsyncGenerator<unknown>;
  resolve: () => void;
} {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });

  const stream = (async function* () {
    await gate;
    yield { cached: true, content };
  })();

  return {
    stream,
    resolve: () => {
      resolveGate?.();
    },
  };
}

describe("useAITranslation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreGetTranslation.mockReturnValue(undefined);
    mockNeedsTranslation.mockReturnValue(true);
    mockTranslationActionsIsDisabled.mockReturnValue(false);
  });

  it("切换到 Readability 且无需翻译时会中断当前翻译并停止 loading", async () => {
    mockNeedsTranslation.mockImplementation(
      (_title: string, summary: string | null) => {
        return !(summary ?? "").includes("already-target");
      },
    );
    mockStreamTranslateBlocks.mockImplementation((_req, signal) =>
      createAbortAwarePendingStream(signal),
    );

    const entry = createEntry("foreign normal content to translate");
    const { result, rerender } = renderHook(
      (props: { isReadableActive: boolean }) =>
        useAITranslation({
          entry,
          isReadableActive: props.isReadableActive,
          readableContent: "already-target readability content",
          autoTranslate: true,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { isReadableActive: false } },
    );

    await waitFor(() => {
      expect(result.current.isTranslating).toBe(true);
    });
    expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(1);

    rerender({ isReadableActive: true });

    await waitFor(() => {
      expect(result.current.isTranslating).toBe(false);
    });
    expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(1);
    expect(result.current.translatedContent).toBeNull();
  });

  it("旧请求晚到的缓存结果不会覆盖当前模式翻译状态", async () => {
    const staleStream = createDeferredCachedStream("stale-normal-content");
    let callCount = 0;

    mockNeedsTranslation.mockReturnValue(true);
    mockStreamTranslateBlocks.mockImplementation((_req, signal) => {
      callCount += 1;
      if (callCount === 1) {
        return staleStream.stream;
      }
      return createAbortAwarePendingStream(signal);
    });

    const entry = createEntry("foreign normal content");
    const { result, rerender } = renderHook(
      (props: { isReadableActive: boolean }) =>
        useAITranslation({
          entry,
          isReadableActive: props.isReadableActive,
          readableContent: "foreign readability content",
          autoTranslate: true,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { isReadableActive: false } },
    );

    await waitFor(() => {
      expect(result.current.isTranslating).toBe(true);
    });

    rerender({ isReadableActive: true });

    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      staleStream.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.translatedContent).toBeNull();
    expect(result.current.isTranslating).toBe(true);
  });

  it("切回原始内容后会重新触发自动翻译", async () => {
    mockNeedsTranslation.mockImplementation(
      (_title: string, summary: string | null) => {
        return !(summary ?? "").includes("already-target");
      },
    );

    let callCount = 0;
    mockStreamTranslateBlocks.mockImplementation((_req, signal) => {
      callCount += 1;
      if (callCount === 1) {
        return createAbortAwarePendingStream(signal);
      }
      return (async function* () {
        yield { done: true };
      })();
    });

    const entry = createEntry("foreign normal content");
    const { result, rerender } = renderHook(
      (props: { isReadableActive: boolean }) =>
        useAITranslation({
          entry,
          isReadableActive: props.isReadableActive,
          readableContent: "already-target readability content",
          autoTranslate: true,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { isReadableActive: false } },
    );

    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(1);
      expect(result.current.isTranslating).toBe(true);
    });

    rerender({ isReadableActive: true });

    await waitFor(() => {
      expect(result.current.isTranslating).toBe(false);
    });

    rerender({ isReadableActive: false });

    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    });
  });
});
/**
 * 49-2 / 49-3 回归（用户 2026-10-12）：
 * - 正文里的块翻失败时必须给可见原因（原来静默留原文 ⇒ 用户只看到「标题翻了、正文没翻」）
 * - 「正在自动翻译…」同一条条目只弹一次（原来这条链路会为同一条目跑两遍，列表快速切换就叠一屏）
 */
function readToasts(): { id: number; message: string }[] {
  const { result } = renderHook(() => useToasts());
  return result.current;
}

function clearToasts(): void {
  const { result } = renderHook(() => useToasts());
  act(() => {
    for (const toast of result.current) dismissToast(toast.id);
  });
}

/** 测试环境没有初始化 i18n ⇒ t() 会退回 key；两种都认，避免断言绑死译文 */
const isAutoTranslateToast = (message: string) =>
  message.includes("auto_translate_on") || message.startsWith("正在自动翻译");
const isFailureToast = (message: string) =>
  message.includes("translate_blocks_failed") || message.includes("没译出来");

describe("useAITranslation · 翻译提示与失败可见（49-2/49-3）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNeedsTranslation.mockReturnValue(true);
    mockStoreGetTranslation.mockReturnValue(undefined);
    mockTranslationActionsIsDisabled.mockReturnValue(false);
    mockTranslateArticlesBatch.mockResolvedValue(undefined);
    clearToasts();
  });

  it("同一条条目只弹一次「正在自动翻译…」", async () => {
    // 实际链路：预载那条没落库时会「再自己发一次」⇒ 这一条条目会被翻译两次
    mockStreamTranslateBlocks.mockImplementation(() =>
      (async function* () {
        yield { done: true };
      })(),
    );

    const entry = createEntry("foreign normal content");
    const { result } = renderHook(() =>
      useAITranslation({
        entry,
        isReadableActive: false,
        readableContent: null,
        autoTranslate: true,
        targetLanguage: "zh-CN",
      }),
    );

    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalled();
      expect(result.current.isTranslating).toBe(false);
    });
    await waitFor(() => {
      expect(readToasts().filter((toast) => isAutoTranslateToast(toast.message))).toHaveLength(1);
    });
  });

  it("有块翻译失败时弹一条带原因的提示（不再静默）", async () => {
    mockStreamTranslateBlocks.mockImplementation(() =>
      (async function* () {
        yield { index: 0, html: "<p>ok</p>" };
        yield {
          error:
            "block 1: dial tcp 127.0.0.1:8000: connect: connection refused",
        };
        yield { done: true };
      })(),
    );

    const entry = createEntry("foreign normal content");
    renderHook(() =>
      useAITranslation({
        entry,
        isReadableActive: false,
        readableContent: null,
        autoTranslate: true,
        targetLanguage: "zh-CN",
      }),
    );

    await waitFor(() => {
      const failed = readToasts().filter((toast) => isFailureToast(toast.message));
      expect(failed).toHaveLength(1);
      // 原因要带出来（i18n 没初始化时至少 key 在，不绑死语言）
      expect(failed.map((toast) => toast.message).join("")).toMatch(
        /connection refused|translate_blocks_failed/,
      );
    });
  });
});
