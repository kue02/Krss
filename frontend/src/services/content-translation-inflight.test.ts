/**
 * 正文翻译在途登记表的单测。
 *
 * 它存在只为一件事：**同一条内容不被跑两遍模型**。所以这里断言的核心是
 * 「claim 拿不到 = 必须真的别发」「finish 之后订阅方一定被唤醒（不能挂死在翻译中）」。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  attachContentTranslation,
  claimContentTranslation,
  contentTranslationKey,
  isContentTranslationInFlight,
  resetContentTranslationInFlight,
} from "./content-translation-inflight";

describe("contentTranslationKey", () => {
  it("条目 / 模式 / 语言 任一不同就是不同的 key", () => {
    expect(contentTranslationKey("1", false, "zh-CN")).not.toBe(
      contentTranslationKey("2", false, "zh-CN"),
    );
    expect(contentTranslationKey("1", false, "zh-CN")).not.toBe(
      contentTranslationKey("1", true, "zh-CN"),
    );
    expect(contentTranslationKey("1", false, "zh-CN")).not.toBe(
      contentTranslationKey("1", false, "en"),
    );
  });
});

describe("claimContentTranslation / attachContentTranslation", () => {
  beforeEach(() => {
    resetContentTranslationInFlight();
  });

  it("第一次能拿到，第二次拿不到（同一条不许重复发）", () => {
    const first = claimContentTranslation("1", false, "zh-CN");
    expect(first).not.toBeNull();
    expect(claimContentTranslation("1", false, "zh-CN")).toBeNull();
    // 换了模式/语言是另一次翻译，可以同时进行
    expect(claimContentTranslation("1", true, "zh-CN")).not.toBeNull();
    expect(claimContentTranslation("1", false, "en")).not.toBeNull();
  });

  it("没有在途时 attach 返回 null（调用方据此自己发请求）", () => {
    expect(
      attachContentTranslation("1", false, "zh-CN", () => {}),
    ).toBeNull();
  });

  it("订阅方能收到发起方转发的事件（打开路径照样逐块出）", () => {
    const claim = claimContentTranslation("1", false, "zh-CN")!;
    const seen: string[] = [];
    const attached = attachContentTranslation("1", false, "zh-CN", (event) => {
      seen.push("cached" in event ? `cached:${event.content}` : JSON.stringify(event));
    });
    expect(attached).not.toBeNull();

    claim.emit({ cached: true, content: "<p>译</p>" });
    claim.emit({ index: 1, html: "<p>块</p>" } as never);
    expect(seen).toEqual(['cached:<p>译</p>', '{"index":1,"html":"<p>块</p>"}']);
  });

  it("finish 唤醒订阅方、摘掉登记、之后可以重新 claim", async () => {
    const claim = claimContentTranslation("1", false, "zh-CN")!;
    let released = false;
    const attached = attachContentTranslation("1", false, "zh-CN", () => {});
    void attached?.then(() => {
      released = true;
    });

    expect(isContentTranslationInFlight("1", false, "zh-CN")).toBe(true);
    claim.finish();

    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
    expect(isContentTranslationInFlight("1", false, "zh-CN")).toBe(false);
    expect(claimContentTranslation("1", false, "zh-CN")).not.toBeNull();
  });

  it("finish 之后不再把事件送给旧订阅方", () => {
    const claim = claimContentTranslation("1", false, "zh-CN")!;
    const listener = vi.fn();
    attachContentTranslation("1", false, "zh-CN", listener);
    claim.finish();
    claim.emit({ cached: true, content: "x" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("订阅方抛错不影响发起方继续转发", () => {
    const claim = claimContentTranslation("1", false, "zh-CN")!;
    const good = vi.fn();
    attachContentTranslation("1", false, "zh-CN", () => {
      throw new Error("boom");
    });
    attachContentTranslation("1", false, "zh-CN", good);

    expect(() => claim.emit({ cached: true, content: "x" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("done 与 finish 同步：订阅方能拿到「发起方结束了」", async () => {
    const claim = claimContentTranslation("1", false, "zh-CN")!;
    let done = false;
    void claim.done.then(() => {
      done = true;
    });
    claim.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});
