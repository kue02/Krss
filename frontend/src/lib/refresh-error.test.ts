import { describe, expect, it } from "vitest";
import { describeRefreshError } from "./refresh-error";
import type { TFunction } from "i18next";

/** t 的替身：key + 插值直接拼成可断言的字符串 */
const t = ((key: string, opts?: Record<string, unknown>) =>
  `${key}?${opts ? JSON.stringify(opts) : ""}`) as unknown as TFunction<
  "translation",
  undefined
>;

describe("describeRefreshError", () => {
  it("把 RSSHub 路由不存在的前缀翻译成 i18n 文案", () => {
    const got = describeRefreshError(
      "rsshub route not found: /twitter/user/elikikosk",
      t,
    );
    expect(got).toBe(
      `refresh_tooltip.rsshub_route_not_found?${JSON.stringify({
        detail: "/twitter/user/elikikosk",
      })}`,
    );
  });

  it("把 RSSHub 上游失败的前缀翻译成 i18n 文案", () => {
    const got = describeRefreshError(
      "rsshub upstream error: Twitter API returned an incomplete user response",
      t,
    );
    expect(got).toContain("refresh_tooltip.rsshub_upstream_error");
    expect(got).toContain("Twitter API returned an incomplete user response");
  });

  it("把 RSSHub 连不上的前缀翻译成 i18n 文案", () => {
    expect(
      describeRefreshError("rsshub unreachable: dial timeout", t),
    ).toContain("refresh_tooltip.rsshub_unreachable");
  });

  it("老数据 / 非 RSSHub 源的错误原样透传", () => {
    expect(describeRefreshError("HTTP 404", t)).toBe("HTTP 404");
    expect(describeRefreshError("upstream rejected", t)).toBe(
      "upstream rejected",
    );
  });

  it("空串安全", () => {
    expect(describeRefreshError(undefined, t)).toBe("");
    expect(describeRefreshError("", t)).toBe("");
  });
});
