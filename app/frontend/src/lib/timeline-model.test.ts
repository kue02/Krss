import { describe, expect, it } from "vitest";
import {
  bucketStartMs,
  buildTimelineRows,
  entryTimestamp,
  expandTimelineRows,
  formatBucketLabel,
  formatClockTime,
  isSingleSideWidth,
  localDayKey,
  resolveTimelineCollapse,
  resolveTimelineGranularity,
  resolveTimelineTimeBasis,
  timelineCollapseClampLines,
  TIMELINE_SINGLE_SIDE_WIDTH,
  type TimelineRow,
} from "./timeline-model";
import type { Entry } from "@/types/api";

/** 测试里的 t 直接回 key（断言标签时看得到是哪一条文案） */
const t = (key: string, options?: Record<string, unknown>) =>
  options?.count !== undefined ? `${key}:${options.count}` : key;

function entry(id: string, publishedAt: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    feedId: "f1",
    title: `title ${id}`,
    content: `<p>body ${id}</p>`,
    publishedAt,
    read: false,
    starred: false,
    muted: false,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...extra,
  };
}

/** 本地时区的时间戳（`publishedAt` 后端给的是 RFC3339 UTC 串，这里按本地时间造） */
function localIso(year: number, month: number, day: number, hour: number, minute: number) {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.toISOString();
}

function kinds(rows: TimelineRow[]) {
  return rows.map((row) => row.kind);
}

describe("timeline-model · 档位解析", () => {
  it("认不出的粒度 / 折叠档一律回默认（每小时 / 2 行）", () => {
    expect(resolveTimelineGranularity("weekly")).toBe("hour");
    expect(resolveTimelineGranularity(undefined)).toBe("hour");
    expect(resolveTimelineGranularity("minute")).toBe("minute");
    expect(resolveTimelineCollapse("9")).toBe("2");
    expect(resolveTimelineCollapse(null)).toBe("2");
    expect(resolveTimelineCollapse("full")).toBe("full");
  });

  it("折叠档位 → 行数：1/2/3 有值，全文 = null（不折）", () => {
    expect(timelineCollapseClampLines("1")).toBe(1);
    expect(timelineCollapseClampLines("3")).toBe(3);
    expect(timelineCollapseClampLines("full")).toBeNull();
  });

  it("窄栏阈值 768px（移动端断点）：小于才退化（等于 / 更大都不退）", () => {
    expect(isSingleSideWidth(TIMELINE_SINGLE_SIDE_WIDTH - 1)).toBe(true);
    expect(isSingleSideWidth(655)).toBe(true);
    expect(isSingleSideWidth(TIMELINE_SINGLE_SIDE_WIDTH)).toBe(false);
    expect(isSingleSideWidth(1024)).toBe(false);
    // 还没量到宽度（0）时不要擅自退化
    expect(isSingleSideWidth(0)).toBe(false);
  });
});

describe("timeline-model · 分桶", () => {
  it("四档粒度对齐到各自的桶起点", () => {
    const ms = new Date(2026, 8, 18, 14, 47, 33, 500).getTime();
    expect(formatClockTime(bucketStartMs(ms, "minute"))).toBe("14:47");
    expect(formatClockTime(bucketStartMs(ms, "quarter"))).toBe("14:45");
    expect(formatClockTime(bucketStartMs(ms, "hour"))).toBe("14:00");
    const day = new Date(bucketStartMs(ms, "day"));
    expect([day.getHours(), day.getMinutes()]).toEqual([0, 0]);
    expect(localDayKey(bucketStartMs(ms, "day"))).toBe("2026-09-18");
  });
});

describe("timeline-model · 行序列", () => {
  const now = new Date(2026, 8, 18, 15, 0, 0).getTime();

  it("最新在上：同一天同一小时的三条共用一个头节点（major）+ 两个小节点（minor）", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 14, 32)),
      entry("b", localIso(2026, 9, 18, 14, 10)),
      entry("c", localIso(2026, 9, 18, 14, 5)),
    ];
    const rows = buildTimelineRows(entries, {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });

    // 跨天分隔 + 三条
    expect(kinds(rows)).toEqual(["date", "entry", "entry", "entry"]);
    const [, first, second, third] = rows;
    expect(first?.kind === "entry" && first.node).toBe("major");
    // 头节点的标注是粒度桶的时间（每小时 → 14:00），不是条目自己的 14:32
    expect(first?.kind === "entry" && first.label).toBe("14:00");
    expect(first?.kind === "entry" && first.bucketCount).toBe(3);
    expect(second?.kind === "entry" && second.node).toBe("minor");
    // 小节点给自己的精确时间
    expect(second?.kind === "entry" && second.label).toBe("14:10");
    expect(third?.kind === "entry" && third.label).toBe("14:05");
  });

  it("左右交替：按行依次左右，日期分隔不占位", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 14, 10)),
      entry("b", localIso(2026, 9, 18, 13, 10)),
      entry("c", localIso(2026, 9, 18, 12, 10)),
      entry("d", localIso(2026, 9, 18, 11, 10)),
    ];
    const rows = buildTimelineRows(entries, {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });
    expect(rows.filter((row) => row.kind === "entry").map((row) => row.side)).toEqual([
      "left",
      "right",
      "left",
      "right",
    ]);
  });

  it("跨天插日期分隔（今天 / 昨天 / 具体日期）", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 10, 0)),
      entry("b", localIso(2026, 9, 17, 10, 0)),
      entry("c", localIso(2026, 9, 16, 10, 0)),
    ];
    const rows = buildTimelineRows(entries, {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });
    const dates = rows.filter((row) => row.kind === "date");
    expect(dates.map((row) => (row.kind === "date" ? row.label : ""))).toEqual([
      "timeline.today",
      "timeline.yesterday",
      expect.any(String),
    ]);
    // 日期分隔插在当天的第一条之前
    expect(kinds(rows)).toEqual(["date", "entry", "date", "entry", "date", "entry"]);
  });

  it("粒度只影响分组与节点标注：换档不改条目数、也不改顺序", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 14, 47)),
      entry("b", localIso(2026, 9, 18, 14, 46)),
      entry("c", localIso(2026, 9, 18, 14, 12)),
      entry("d", localIso(2026, 9, 18, 13, 59)),
    ];
    const idsOf = (granularity: "minute" | "quarter" | "hour" | "day") =>
      buildTimelineRows(entries, { granularity, t, now, locale: "zh-CN" })
        .filter((row) => row.kind === "entry")
        .map((row) => row.entry.id);

    // 四种粒度的条目集合与顺序完全一致
    expect(idsOf("minute")).toEqual(["a", "b", "c", "d"]);
    expect(idsOf("quarter")).toEqual(["a", "b", "c", "d"]);
    expect(idsOf("hour")).toEqual(["a", "b", "c", "d"]);
    expect(idsOf("day")).toEqual(["a", "b", "c", "d"]);

    const majorsOf = (granularity: "minute" | "quarter" | "hour" | "day") =>
      buildTimelineRows(entries, { granularity, t, now, locale: "zh-CN" })
        .filter(
          (row): row is Extract<TimelineRow, { kind: "entry" }> =>
            row.kind === "entry" && row.node === "major",
        )
        .map((row) => row.label);

    // 只有分组与标注变了：精确到分 → 每 15 分钟（14:45 一桶 / 14:00 一桶）/ 每小时 / 每天
    expect(majorsOf("minute")).toEqual(["14:47", "14:46", "14:12", "13:59"]);
    expect(majorsOf("quarter")).toEqual(["14:45", "14:00", "13:45"]);
    expect(majorsOf("hour")).toEqual(["14:00", "13:00"]);
    expect(majorsOf("day")).toEqual(["timeline.today"]);
  });

  it("同一个桶太密集时吸成小节点 + 计数（每天档：6 条 → 3 张卡 + 一簇 3 条）", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, localIso(2026, 9, 17, 20 - index, 0)),
    );
    const rows = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
    });

    expect(kinds(rows)).toEqual(["date", "entry", "entry", "entry", "cluster"]);
    const cluster = rows[rows.length - 1];
    expect(cluster?.kind === "cluster" && cluster.count).toBe(3);
    expect(cluster?.kind === "cluster" && cluster.entries.map((item) => item.id)).toEqual([
      "d",
      "e",
      "f",
    ]);
    // 头节点上的计数是整桶的条数（含被吸掉的）
    const major = rows.find((row) => row.kind === "entry" && row.node === "major");
    expect(major?.kind === "entry" && major.bucketCount).toBe(6);
  });

  it("桶里只有 4 条时不吸（只吸 1 条等于让人白点一次）", () => {
    const entries = ["a", "b", "c", "d"].map((id, index) =>
      entry(id, localIso(2026, 9, 17, 20 - index, 0)),
    );
    const rows = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
    });
    expect(rows.some((row) => row.kind === "cluster")).toBe(false);
    expect(rows.filter((row) => row.kind === "entry")).toHaveLength(4);
  });

  it("展开了的小节点摊在它下面（小节点留着，能再收回去）", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, localIso(2026, 9, 17, 20 - index, 0)),
    );
    const rows = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
    });
    const cluster = rows.find((row) => row.kind === "cluster");
    expect(cluster?.kind).toBe("cluster");

    const expanded = expandTimelineRows(rows, new Set([cluster!.key]));
    // 小节点还在（否则就没法收回去），而且就在原来那一格
    const clusterIndex = expanded.findIndex((row) => row.kind === "cluster");
    expect(clusterIndex).toBe(4);
    expect(expanded.filter((row) => row.kind === "entry")).toHaveLength(6);

    // 摊出来的三条紧跟在小节点后面，且左右交替
    const tail = expanded.slice(clusterIndex + 1);
    expect(tail.map((row) => (row.kind === "entry" ? row.entry.id : "x"))).toEqual([
      "d",
      "e",
      "f",
    ]);
    const clusterSide = cluster?.kind === "cluster" ? cluster.side : null;
    const sides = tail.map((row) => (row.kind === "entry" ? row.side : null));
    expect(sides[0]).toBe(clusterSide);
    expect(sides[1]).not.toBe(sides[0]);
    expect(sides[2]).toBe(sides[0]);

    // 没展开的簇保持原样（幂等：不点就不动）
    expect(expandTimelineRows(rows, new Set()).filter((row) => row.kind === "cluster")).toHaveLength(
      1,
    );
  });

  it("标注：今天只给时间，更早的补上日期", () => {
    const todayMs = new Date(2026, 8, 18, 9, 30).getTime();
    const olderMs = new Date(2026, 8, 15, 9, 30).getTime();
    expect(formatBucketLabel(todayMs, "hour", now, t, "zh-CN")).toBe("09:00");
    expect(formatBucketLabel(olderMs, "hour", now, t, "zh-CN")).toContain("09:00");
    expect(formatBucketLabel(olderMs, "hour", now, t, "zh-CN")).not.toBe("09:00");
  });

  it("C-②：shortLabel 永远只有 HH:MM（跨天头节点也不带日期）", () => {
    const rows = buildTimelineRows(
      [entry("a", localIso(2026, 9, 15, 9, 30))],
      {
        granularity: "hour",
        t,
        now,
        locale: "zh-CN",
      },
    );
    const first = rows.find((row) => row.kind === "entry");
    expect(first?.kind === "entry" && first.label).not.toBe("09:00");
    expect(first?.kind === "entry" && first.shortLabel).toBe("09:00");
  });
});

describe("timeline-model · 日期行 rangeLabel（26-4）", () => {
  const now = new Date(2026, 8, 18, 15, 0, 0).getTime();

  it("同天多条：rangeLabel = min~max（en dash –，按 timeBasis 取时间）", () => {
    const rows = buildTimelineRows(
      [
        entry("a", localIso(2026, 9, 18, 9, 5)),
        entry("b", localIso(2026, 9, 18, 12, 40)),
        entry("c", localIso(2026, 9, 18, 10, 15)),
      ],
      { granularity: "hour", t, now, locale: "zh-CN" },
    );
    const dates = rows.filter((row) => row.kind === "date");
    expect(dates).toHaveLength(1);
    expect(dates[0]?.kind === "date" && dates[0].rangeLabel).toBe("09:05–12:40");
  });

  it("单条：rangeLabel = 单个时间", () => {
    const rows = buildTimelineRows([entry("a", localIso(2026, 9, 18, 9, 5))], {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });
    const date = rows.find((row) => row.kind === "date");
    expect(date?.kind === "date" && date.rangeLabel).toBe("09:05");
  });

  it("跨天各算各的：同一天多个桶也只汇总当天", () => {
    const rows = buildTimelineRows(
      [
        entry("a", localIso(2026, 9, 18, 14, 0)),
        entry("b", localIso(2026, 9, 18, 9, 0)),
        entry("c", localIso(2026, 9, 17, 20, 30)),
        entry("d", localIso(2026, 9, 17, 8, 15)),
      ],
      { granularity: "hour", t, now, locale: "zh-CN" },
    );
    const dates = rows.filter((row) => row.kind === "date");
    expect(dates).toHaveLength(2);
    expect(dates[0]?.kind === "date" && dates[0].rangeLabel).toBe("09:00–14:00");
    expect(dates[1]?.kind === "date" && dates[1].rangeLabel).toBe("08:15–20:30");
  });

  it("缺时间（at=0）：不生成 rangeLabel", () => {
    const bad = entry("x", localIso(2026, 9, 18, 9, 0), {
      publishedAt: "not-a-date",
      createdAt: "also-bad",
    });
    expect(entryTimestamp(bad)).toBe(0);
    const rows = buildTimelineRows([bad], {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });
    const date = rows.find((row) => row.kind === "date");
    expect(date?.kind).toBe("date");
    expect(date?.kind === "date" && date.rangeLabel).toBeUndefined();
  });
});

describe("timeline-model · 时间基准（发布时间 / 抓取时间）", () => {
  const now = new Date(2026, 8, 18, 15, 0, 0).getTime();

  it("认不出的时间基准一律回发布时间（默认档，现状不动）", () => {
    expect(resolveTimelineTimeBasis("weekly")).toBe("published");
    expect(resolveTimelineTimeBasis(undefined)).toBe("published");
    expect(resolveTimelineTimeBasis(null)).toBe("published");
    expect(resolveTimelineTimeBasis("published")).toBe("published");
    expect(resolveTimelineTimeBasis("fetched")).toBe("fetched");
  });

  it("entryTimestamp：默认发布时间；抓取时间按 createdAt（发布时间缺失时互为回退）", () => {
    const item = entry("x", localIso(2026, 9, 16, 10, 0), {
      createdAt: localIso(2026, 9, 18, 9, 0),
    });
    // 默认 = 发布时间（现状）
    expect(entryTimestamp(item)).toBe(Date.parse(localIso(2026, 9, 16, 10, 0)));
    expect(entryTimestamp(item, "published")).toBe(
      Date.parse(localIso(2026, 9, 16, 10, 0)),
    );
    expect(entryTimestamp(item, "fetched")).toBe(
      Date.parse(localIso(2026, 9, 18, 9, 0)),
    );
    // 没有 publishedAt 的条目：两档都退回另一边，不会掉到 0
    const noPublished = entry("y", localIso(2026, 9, 17, 8, 0), {
      publishedAt: undefined,
      createdAt: localIso(2026, 9, 17, 8, 0),
    });
    expect(entryTimestamp(noPublished, "published")).toBe(
      Date.parse(localIso(2026, 9, 17, 8, 0)),
    );
    expect(entryTimestamp(noPublished, "fetched")).toBe(
      Date.parse(localIso(2026, 9, 17, 8, 0)),
    );
  });

  it("默认不传 timeBasis = 显式发布时间（行为零变化）", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 14, 32)),
      entry("b", localIso(2026, 9, 18, 14, 10)),
      entry("c", localIso(2026, 9, 17, 9, 0)),
    ];
    const implicit = buildTimelineRows(entries, {
      granularity: "hour",
      t,
      now,
      locale: "zh-CN",
    });
    const explicit = buildTimelineRows(entries, {
      granularity: "hour",
      timeBasis: "published",
      t,
      now,
      locale: "zh-CN",
    });
    expect(implicit).toEqual(explicit);
  });

  it("抓取时间按 createdAt 分组（同发布日、不同抓取日 → 每天档下两个日期分隔）", () => {
    const entries = [
      entry("a", localIso(2026, 9, 16, 10, 0), {
        createdAt: localIso(2026, 9, 18, 9, 0),
      }),
      entry("b", localIso(2026, 9, 16, 11, 0), {
        createdAt: localIso(2026, 9, 17, 9, 0),
      }),
    ];
    // 发布时间：同一天 → 只有一个日期分隔
    const published = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
    });
    expect(published.filter((row) => row.kind === "date")).toHaveLength(1);
    // 抓取时间：不同天 → 两个日期分隔，且抓取晚的在上
    const fetched = buildTimelineRows(entries, {
      granularity: "day",
      timeBasis: "fetched",
      t,
      now,
      locale: "zh-CN",
    });
    expect(fetched.filter((row) => row.kind === "date")).toHaveLength(2);
    expect(
      fetched
        .filter((row) => row.kind === "entry")
        .map((row) => (row.kind === "entry" ? row.entry.id : "")),
    ).toEqual(["a", "b"]);
  });

  it("展开态小节点的精确时间也跟时间基准走", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, localIso(2026, 9, 16, 20 - index, 0), {
        createdAt: localIso(2026, 9, 18, 10 - index, 0),
      }),
    );
    const rows = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
    });
    const cluster = rows.find((row) => row.kind === "cluster");
    expect(cluster?.kind).toBe("cluster");

    const tailLabels = (expanded: TimelineRow[]) =>
      expanded
        .slice(-3)
        .map((row) => (row.kind === "entry" ? row.label : ""));
    // 默认 = 发布时间：被吸掉的 d/e/f 是发布日的 17:00/16:00/15:00
    expect(tailLabels(expandTimelineRows(rows, new Set([cluster!.key])))).toEqual(
      ["17:00", "16:00", "15:00"],
    );
    // 抓取时间：同一批是抓取日的 07:00/06:00/05:00
    expect(
      tailLabels(expandTimelineRows(rows, new Set([cluster!.key]), "fetched")),
    ).toEqual(["07:00", "06:00", "05:00"]);
  });
});
