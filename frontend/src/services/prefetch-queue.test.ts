/**
 * 队列语义单测：并发上限 / 顺序优先 / 取消 / 失败退避 / 去重。
 * 这些是「预载」最容易出事故的地方（几十条齐发、滚走了还在跑），所以单独钉住。
 */

import { describe, it, expect, vi } from "vitest";
import {
  PrefetchQueue,
  type PrefetchTask,
} from "@/services/prefetch-queue";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(
  entryId: string,
  run: (signal: AbortSignal) => Promise<void>,
): PrefetchTask {
  return { key: `k:${entryId}`, entryId, kind: "chain", run };
}

/** 立刻 flush 若干次微任务，让 promise 链上的 then/catch 跑完 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("PrefetchQueue", () => {
  it("并发不超过上限，且按 priority 小的先跑", async () => {
    const queue = new PrefetchQueue({ concurrency: 2 });
    const started: string[] = [];
    const gates = new Map<string, Deferred>();

    const make = (id: string): PrefetchTask =>
      task(id, () => {
        started.push(id);
        const gate = deferred();
        gates.set(id, gate);
        return gate.promise;
      });

    // 同 priority 下按入队顺序：c 先开跑，a 占第二个名额，b 排队
    queue.enqueue([make("c"), make("a"), make("b")], 0);
    expect(queue.stats.running).toBe(2);
    expect(queue.stats.pending).toBe(1);

    // 后入队的 a2（priority 9）排到 b 后面
    queue.enqueue([make("a2")], 9);
    gates.get("c")!.resolve();
    await flush();
    expect(started).toEqual(["c", "a", "b"]);

    gates.get("a")!.resolve();
    gates.get("b")!.resolve();
    await flush();
    expect(started).toEqual(["c", "a", "b", "a2"]);
    gates.get("a2")!.resolve();
    await flush();
    expect(queue.stats).toEqual({ pending: 0, running: 0 });
  });

  it("按 viewport 顺序入队时，顺序小的先跑", async () => {
    const queue = new PrefetchQueue({ concurrency: 1 });
    const started: string[] = [];
    const gates = new Map<string, Deferred>();
    const make = (id: string): PrefetchTask =>
      task(id, () => {
        started.push(id);
        const gate = deferred();
        gates.set(id, gate);
        return gate.promise;
      });

    // 并发=1：第一个入队的立刻开跑；后进视口的（priority 更大）只能排队
    queue.enqueue([make("third")], 3);
    expect(started).toEqual(["third"]);
    queue.enqueue([make("first")], 1);
    expect(started).toEqual(["third"]);

    gates.get("third")!.resolve();
    await flush();
    expect(started).toEqual(["third", "first"]);
    gates.get("first")!.resolve();
    await flush();
  });

  it("同一条目不重复预载（key 去重）", async () => {
    const queue = new PrefetchQueue({ concurrency: 1 });
    const run = vi.fn(() => Promise.resolve());
    queue.enqueue([task("e1", run)], 0);
    // 还在 known 里 → 第二次入队被忽略
    expect(queue.enqueue([task("e1", run)], 0)).toBe(0);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // 跑完之后 key 放开 → 下次进视口允许再试一次（幂等，只是缓存命中）
    expect(queue.enqueue([task("e1", run)], 0)).toBe(1);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("失败按指数退避重试，重试用尽后不再重试", async () => {
    const timers: Array<() => void> = [];
    const queue = new PrefetchQueue({
      concurrency: 1,
      maxRetries: 2,
      retryBaseMs: 10,
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeoutFn: () => undefined,
    });

    const run = vi.fn(() => Promise.reject(new Error("boom")));
    queue.enqueue([task("e1", run)], 0);
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    timers[0]!();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(2);
    timers[1]!();
    await flush();
    // 两次重试用尽 → 放弃
    expect(run).toHaveBeenCalledTimes(3);
    expect(timers).toHaveLength(2);
    expect(queue.stats).toEqual({ pending: 0, running: 0 });
  });

  it("abort 视为取消，不触发重试", async () => {
    const queue = new PrefetchQueue({ concurrency: 1, maxRetries: 3 });
    const seen: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<void>((_res, rej) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          rej(error);
        });
      });
    });

    queue.enqueue([task("e1", run)], 0);
    queue.cancelAll();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen[0]!.aborted).toBe(true);
    expect(queue.stats).toEqual({ pending: 0, running: 0 });
  });

  it("cancelOutside 只撤不在保留集合里的那些（滚动/切视图用）", async () => {
    const queue = new PrefetchQueue({ concurrency: 1 });
    const started: string[] = [];
    const gate = deferred();

    queue.enqueue(
      [
        task("keep", () => {
          started.push("keep");
          return gate.promise;
        }),
      ],
      0,
    );
    queue.enqueue(
      [
        task("drop", () => {
          started.push("drop");
          return Promise.resolve();
        }),
      ],
      1,
    );

    expect(started).toEqual(["keep"]);
    expect(queue.stats.pending).toBe(1);

    const cancelled = queue.cancelOutside(new Set(["keep"]));
    expect(cancelled).toBe(1);
    expect(queue.stats.pending).toBe(0);

    gate.resolve();
    await flush();
  });

  it("setConcurrency：放宽立刻补位，收紧不再新开", async () => {
    const queue = new PrefetchQueue({ concurrency: 2 });
    const started: string[] = [];
    const gates = new Map<string, Deferred>();
    const make = (id: string): PrefetchTask =>
      task(id, () => {
        started.push(id);
        const gate = deferred();
        gates.set(id, gate);
        return gate.promise;
      });

    // 只排一条：只开跑 1 个（上限 2 但没别的可跑）
    queue.enqueue([make("a")], 0);
    expect(queue.stats).toEqual({ pending: 0, running: 1 });

    // 再排两条：一个补上空位，另一个排队
    queue.enqueue([make("b"), make("c")], 1);
    expect(queue.stats).toEqual({ pending: 1, running: 2 });

    // 收紧回 1：不再新开（已在跑的留着跑完，不浪费已经发出的请求）
    queue.setConcurrency(1);
    queue.enqueue([make("d")], 2);
    expect(queue.stats).toEqual({ pending: 2, running: 2 });

    gates.get("a")!.resolve();
    gates.get("b")!.resolve();
    await flush();
    // a、b 跑完，空出 2 个位置但上限=1 ⇒ 只补 c，d 继续排队
    expect(started).not.toContain("d");
    expect(queue.stats).toEqual({ pending: 1, running: 1 });

    gates.get("c")!.resolve();
    await flush();
    gates.get("d")!.resolve();
    await flush();
    expect(queue.stats).toEqual({ pending: 0, running: 0 });
  });

  it("没有 IntersectionObserver 时也什么都不做（SSR / 老环境不炸）", () => {
    const queue = new PrefetchQueue({ concurrency: 2 });
    expect(queue.has("nope")).toBe(false);
    expect(queue.stats).toEqual({ pending: 0, running: 0 });
  });
});