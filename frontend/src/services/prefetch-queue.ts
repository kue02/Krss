/**
 * 条目「进视口就后台预载」的执行队列。
 *
 * 背景：订阅级的「阅读模式 / 摘要 / 翻译」三态原来是**点开条目时**才发起请求的，
 * 于是每点一条都要等一次抓取（正文）或一次模型往返（摘要 / 翻译）。
 * 这里把同一批请求提前到条目进入列表视口时跑，点开时命中后端缓存 / 前端 store。
 *
 * 三条纪律（对应卡片上的硬要求）：
 *  1. **并发上限**：一屏几十条不能同时打出去，默认 2 条在跑；
 *  2. **顺序优先**：按进入视口的顺序先进先出（priority 越小越先），新进视口的排在队尾；
 *  3. **可取消**：滚出视口 / 切换视图要能 abort 在跑的请求（AbortController），
 *     失败按指数退避重试若干次，**全程静默**（不弹 toast —— 打开路径那两条提示原样保留，
 *     那是「打开」这个动作的交代，预载不是）。
 */

/** 一次预载可能只做一件事，也可能按「正文 → 摘要 → 翻译」的链条一起做 */
export type PrefetchKind = "readable" | "summary" | "translate" | "chain";

export interface PrefetchTask {
  /** 同一条目同一件事只预载一次（后端侧大多幂等，但没必要白跑一趟） */
  key: string;
  /** 所属条目 —— 滚出视口时按条目整批取消 */
  entryId: string;
  kind: PrefetchKind;
  run: (signal: AbortSignal) => Promise<void>;
}

interface QueueItem {
  task: PrefetchTask;
  /** 越小越先跑（一般传进入视口的序号） */
  priority: number;
  /** 同优先级内的先后（入队顺序） */
  seq: number;
}

export interface PrefetchQueueOptions {
  concurrency?: number;
  /** 一个任务最多重试几次（不含首次） */
  maxRetries?: number;
  /** 退避基数（ms）：第 n 次重试等 base × 2^n */
  retryBaseMs?: number;
  /** 定时器注入，便于单测里手动推进退避 */
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

export interface PrefetchQueueStats {
  pending: number;
  running: number;
}

export class PrefetchQueue {
  private readonly concurrencyLimit: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => number;
  private readonly clearTimeoutFn: (handle: number) => void;

  /** 已入队或正在跑的 key —— 用来去重 */
  private readonly known = new Set<string>();
  /** 每个 key 已经重试过几次（跨 retry 保留，start() 不重置） */
  private readonly attempts = new Map<string, number>();
  /** 每个 key 已排的退避定时器 —— 取消时必须清掉，否则取消后还会自己跑起来 */
  private readonly retryTimers = new Map<string, { handle: number; entryId: string }>();
  private readonly pending: QueueItem[] = [];
  private readonly running = new Map<string, { controller: AbortController; item: QueueItem }>();

  private seq = 0;
  private concurrency: number;

  constructor(options: PrefetchQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.concurrencyLimit = this.concurrency;
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1500);
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
  }

  /** 改并发上限（设置项调了不必重挂观察器）；会立刻把空出来的名额补上 */
  setConcurrency(value: number): void {
    this.concurrency = Math.min(
      this.concurrencyLimit,
      Math.max(1, value),
    );
    this.pump();
  }

  get stats(): PrefetchQueueStats {
    return { pending: this.pending.length, running: this.running.size };
  }

  /** 队列里 / 在跑的有没有这个 key */
  has(key: string): boolean {
    return this.known.has(key);
  }

  /**
   * 入队一批任务（同一批共享一个 priority，按数组顺序依次排）。
   * 已经知道在跑/已排的直接跳过 —— 不重复预载同一条。
   */
  enqueue(tasks: PrefetchTask[], priority: number): number {
    let added = 0;
    for (const task of tasks) {
      if (this.known.has(task.key)) continue;
      this.known.add(task.key);
      this.seq += 1;
      this.pending.push({ task, priority, seq: this.seq });
      added += 1;
    }
    if (added > 0) this.pump();
    return added;
  }

  /** 取下一个该跑的任务：优先级小的先，同优先级按入队顺序 */
  private takeNext(): QueueItem | undefined {
    if (this.pending.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      const candidate = this.pending[i]!;
      const best = this.pending[bestIndex]!;
      if (
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.seq < best.seq)
      ) {
        bestIndex = i;
      }
    }
    return this.pending.splice(bestIndex, 1)[0];
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const item = this.takeNext();
      if (!item) return;
      this.start(item);
    }
  }

  private start(item: QueueItem): void {
    const controller = new AbortController();
    this.running.set(item.task.key, { controller, item });

    void item.task
      .run(controller.signal)
      .then(() => {
        this.finish(item.task.key, "ok");
      })
      .catch((error: unknown) => {
        this.finish(
          item.task.key,
          error instanceof Error && error.name === "AbortError"
            ? "abort"
            : "error",
        );
      });
  }

  private finish(key: string, outcome: "ok" | "error" | "abort"): void {
    const record = this.running.get(key);
    this.running.delete(key);
    if (!record) return;

    const attempt = this.attempts.get(key) ?? 0;
    if (outcome === "error" && attempt < this.maxRetries) {
      // 指数退避后重试：重试期间这个 key 仍算「已知」，不会重复入队；
      // attempt 记在 attempts 上而不是这条记录上，start() 重跑时不会把它清零。
      this.attempts.set(key, attempt + 1);
      const delay = this.retryBaseMs * 2 ** attempt;
      const handle = this.setTimeoutFn(() => {
        this.retryTimers.delete(key);
        this.start(record.item);
      }, delay);
      this.retryTimers.set(key, { handle, entryId: record.item.task.entryId });
      return;
    }

    // 成功 / 取消 / 重试用尽：放开 key，允许下次进视口再试（幂等，代价只是一次缓存命中）
    this.attempts.delete(key);
    this.known.delete(key);
    this.pump();
  }

  /** 撤掉某个 key 的退避重试（取消时必须调，否则「取消了它还会自己跑起来」） */
  private clearRetryTimer(key: string): void {
    const retry = this.retryTimers.get(key);
    if (retry === undefined) return;
    this.clearTimeoutFn(retry.handle);
    this.retryTimers.delete(key);
  }

  /**
   * 取消不属于 `keepKeys` 的任务。
   * 在跑的 abort 掉，排队的与退避中的直接丢掉 ——
   * 滚出视口的条目没必要继续占位，等它再滚回来重新入队。
   */
  cancelOutside(keepKeys: ReadonlySet<string>): number {
    let cancelled = 0;

    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const item = this.pending[i]!;
      if (keepKeys.has(item.task.entryId)) continue;
      this.pending.splice(i, 1);
      this.clearRetryTimer(item.task.key);
      this.known.delete(item.task.key);
      this.attempts.delete(item.task.key);
      cancelled += 1;
    }

    for (const [key, record] of [...this.running.entries()]) {
      if (keepKeys.has(record.item.task.entryId)) continue;
      record.controller.abort();
      this.running.delete(key);
      this.clearRetryTimer(key);
      this.known.delete(key);
      this.attempts.delete(key);
      cancelled += 1;
    }

    // 已经失败、正等退避的任务：它们既不在 pending 也不在 running，
    // 但 key 还在 known 里 —— 换视图/卸载后必须让它们别自己爬起来重跑。
    for (const [key, retry] of [...this.retryTimers.entries()]) {
      if (keepKeys.has(retry.entryId)) continue;
      this.clearTimeoutFn(retry.handle);
      this.retryTimers.delete(key);
      this.known.delete(key);
      this.attempts.delete(key);
      cancelled += 1;
    }

    return cancelled;
  }

  /** 全清（切换视图 / 卸载） */
  cancelAll(): void {
    this.cancelOutside(new Set<string>());
  }
}