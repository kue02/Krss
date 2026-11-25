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
  mockStripHtml,
} = vi.hoisted(() => ({
  mockStreamTranslateBlocks: vi.fn(),
  mockNeedsTranslation: vi.fn(),
  mockTranslateArticlesBatch: vi.fn(() => Promise.resolve()),
  mockStoreGetTranslation: vi.fn(),
  mockTranslationActionsSet: vi.fn(),
  mockTranslationActionsDisable: vi.fn(),
  mockTranslationActionsEnable: vi.fn(),
  mockTranslationActionsIsDisabled: vi.fn(() => false),
  mockStripHtml: vi.fn((html: string) => html.replace(/<[^>]*>/g, "")),
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

vi.mock("@/lib/language-detect-async", () => ({
  needsTranslation: mockNeedsTranslation,
}));

vi.mock("@/lib/html-utils", () => ({
  stripHtml: mockStripHtml,
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

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

/**
 * 第四十三批（移动端性能）：正文加载瞬间的同步解析 / 异步竞态回归。
 * - 全量 `stripHtml` 不再在正文首帧同步执行，而是挪进空闲回调（`scheduleIdle`）。
 * - 列表里快速切条目时，旧条目晚到的 `needsTranslation` 结果不得落到新条目上
 *   （不得误触发翻译 / 误弹「已自动翻译」toast）。
 */
describe("useAITranslation · 第四十三批空闲解析与切条目竞态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreGetTranslation.mockReturnValue(undefined);
    mockNeedsTranslation.mockReturnValue(true);
    mockTranslationActionsIsDisabled.mockReturnValue(false);
    mockStreamTranslateBlocks.mockImplementation(() =>
      (async function* () {
        yield { done: true };
      })(),
    );
    clearToasts();
  });

  it("未开启 autoTranslate 时，渲染期不解析正文（不阻塞首帧）", async () => {
    const entry = createEntry("foreign normal content");

    renderHook(() =>
      useAITranslation({
        entry,
        isReadableActive: false,
        readableContent: null,
        autoTranslate: false,
        targetLanguage: "zh-CN",
      }),
    );

    // 渲染刚结束、空闲回调还没跑：正文解析（stripHtml）不应发生
    expect(mockStripHtml).not.toHaveBeenCalled();
    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();

    // 推进空闲回调：只有「是否已是目标语言」的判定会异步解析一次，且不发起翻译
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockStripHtml).toHaveBeenCalledTimes(1);
    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();
  });

  it("快速切条目：旧条目晚到的 needsTranslation 不会在新条目上触发翻译或弹 toast", async () => {
    // 用标题区分条目：A 的 needsTranslation 挂起（由测试手动决议），B 直接 false（不需要翻译）
    const pendingA: Array<(value: boolean) => void> = [];
    mockNeedsTranslation.mockImplementation((title: string) =>
      title.startsWith("A")
        ? new Promise<boolean>((resolve) => pendingA.push(resolve))
        : Promise.resolve(false),
    );

    const entryA = { ...createEntry("A foreign body content"), id: "entry-a", title: "A title" };
    const entryB = { ...createEntry("B foreign body content"), id: "entry-b", title: "B title" };

    const { rerender } = renderHook(
      ({ entry }: { entry: Entry }) =>
        useAITranslation({
          entry,
          isReadableActive: false,
          readableContent: null,
          autoTranslate: true,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { entry: entryA } },
    );

    // 让 A 的两个 effect（isAlreadyTargetLanguage + 自动翻译）的空闲回调跑起来，needsTranslation 挂起
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pendingA.length).toBeGreaterThanOrEqual(1);

    // 切换到 B：A 的 effect 会被清理（cancelled=true）
    rerender({ entry: entryB });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A 的 needsTranslation 此刻才晚到 true —— 必须被丢弃
    await act(async () => {
      for (const resolve of pendingA) resolve(true);
      await Promise.resolve();
    });

    // 旧条目的结果不得在新条目上发起翻译，也不得弹「已自动翻译」toast
    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();
    expect(
      readToasts().filter((toast) => isAutoTranslateToast(toast.message)),
    ).toHaveLength(0);
  });

  it("effect 重跑取消掉未完成的 idle 后，仍能重新发起自动翻译（attemptKey 不卡死）", async () => {
    const pending: Array<(value: boolean) => void> = [];
    mockNeedsTranslation.mockImplementation(
      () => new Promise<boolean>((resolve) => pending.push(resolve)),
    );

    const entryA = { ...createEntry("A foreign body content"), id: "entry-a", title: "A title" };

    const { rerender } = renderHook(
      ({ entry }: { entry: Entry }) =>
        useAITranslation({
          entry,
          isReadableActive: false,
          readableContent: null,
          autoTranslate: true,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { entry: entryA } },
    );

    // 第一轮 idle 跑起来：needsTranslation 被调用并挂起（尚未完成）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const firstRoundCalls = pending.length;
    expect(firstRoundCalls).toBeGreaterThanOrEqual(1);

    // 同一条目换一个「新对象引用」→ effect cleanup 取消第一轮 idle（未完成）
    rerender({ entry: { ...entryA } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 第二轮应当重新调度，needsTranslation 又被调用
    expect(pending.length).toBeGreaterThan(firstRoundCalls);

    // 全部决议为 true：第二轮应真正发起翻译（若 attemptKey 卡死则 streamTranslateBlocks 永不调用）
    await act(async () => {
      for (const resolve of pending) resolve(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockStreamTranslateBlocks).toHaveBeenCalled());
  });
});

/**
 * 失败重试 / 手动开关重置（本轮修复）：
 * - generateTranslation 抛错后同条目仍能（有限次）自动重试，且不会无限循环。
 * - 关闭再开启 autoTranslate 会把 attemptKey / 重试计数清掉，重新允许自动翻译。
 * - 用户手动点按钮重试不受自动 attemptKey 限制。
 */
describe("useAITranslation · 失败重试与手动开关重置", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreGetTranslation.mockReturnValue(undefined);
    mockNeedsTranslation.mockReturnValue(true);
    mockTranslationActionsIsDisabled.mockReturnValue(false);
    mockTranslateArticlesBatch.mockResolvedValue(undefined);
    clearToasts();
  });

  it("generateTranslation 失败后会有限重试，到上限即停（不无限循环）", async () => {
    let calls = 0;
    mockStreamTranslateBlocks.mockImplementation(() => {
      calls += 1;
      return (async function* () {
        throw new Error("boom");
      })();
    });

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

    // 第一次失败后自动重试一次 → 共 2 次
    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    });

    // 再等一段时间，确认到上限后不再自动发起
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });

  it("关闭再开启 autoTranslate 会重置重试限制，可再次自动发起", async () => {
    mockStreamTranslateBlocks.mockImplementation(() =>
      (async function* () {
        throw new Error("boom");
      })(),
    );

    const entry = createEntry("foreign normal content");
    const { rerender } = renderHook(
      ({ autoTranslate }: { autoTranslate: boolean }) =>
        useAITranslation({
          entry,
          isReadableActive: false,
          readableContent: null,
          autoTranslate,
          targetLanguage: "zh-CN",
        }),
      { initialProps: { autoTranslate: true } },
    );

    // 先跑到上限 2 次
    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);

    // 关闭再开启：attemptKey / 计数清零 → 允许重新自动发起
    rerender({ autoTranslate: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    rerender({ autoTranslate: true });

    // 重置后重新自动发起（失败会再按上限重试一次），用 >2 证明重置生效
    await waitFor(() => {
      expect(mockStreamTranslateBlocks.mock.calls.length).toBeGreaterThan(2);
    });
  });

  it("用户手动点击翻译不受自动 attemptKey 限制，可再次发起", async () => {
    mockStreamTranslateBlocks.mockImplementation(() =>
      (async function* () {
        throw new Error("boom");
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

    // 自动重试跑到上限 2 次
    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(2);
    });

    // 手动点击：直接 generateTranslation，无视 attemptKey
    await act(async () => {
      await result.current.handleToggleTranslation();
    });

    await waitFor(() => {
      expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(3);
    });
  });
});

