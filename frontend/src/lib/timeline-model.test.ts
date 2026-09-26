import { describe, expect, it } from "vitest";
import {
  bucketStartMs,
  buildTimelineRows,
  entryTimestampByBasis,
  expandTimelineRows,
  formatBucketLabel,
  formatClockTime,
  isSingleSideWidth,
  pickStuckDateKeys,
  localDayKey,
  resolveTimelineCollapse,
  resolveTimelineGranularity,
  resolveTimelineTimeBasis,
  splitTimelineSections,
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
    // 用户 9-24：日期分隔要读到「几月几号」，今天/昨天带相对词前缀
    expect(dates.map((row) => (row.kind === "date" ? row.label : ""))).toEqual([
      "timeline.today · 9月18日 周五",
      "timeline.yesterday · 9月17日 周四",
      "9月16日 周三",
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
    expect(majorsOf("day")).toEqual(["timeline.today · 9月18日 周五"]);
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

describe("timeline-model · 时间基准两档（26-2）", () => {
  const now = new Date(2026, 8, 18, 15, 0, 0).getTime();

  it("认不出的基准一律回发布时间（现状）", () => {
    expect(resolveTimelineTimeBasis("weekly")).toBe("published");
    expect(resolveTimelineTimeBasis(undefined)).toBe("published");
    expect(resolveTimelineTimeBasis("fetched")).toBe("fetched");
    expect(resolveTimelineTimeBasis("published")).toBe("published");
  });

  it("published = publishedAt || createdAt；fetched = createdAt || publishedAt", () => {
    const both = entry("x", localIso(2026, 9, 10, 9, 0), {
      createdAt: localIso(2026, 9, 19, 8, 0),
    });
    // 发布时间档取文章自带时间（9-10），抓取档取本机抓回时间（9-19）
    expect(entryTimestampByBasis(both, "published")).toBe(
      new Date(localIso(2026, 9, 10, 9, 0)).getTime(),
    );
    expect(entryTimestampByBasis(both, "fetched")).toBe(
      new Date(localIso(2026, 9, 19, 8, 0)).getTime(),
    );
  });

  it("缺对应时间退回另一个，不得丢条目", () => {
    const noPublished = entry("np", localIso(2026, 9, 19, 8, 0), {
      publishedAt: undefined,
    });
    // 没有 publishedAt：两档都退回 createdAt
    expect(entryTimestampByBasis(noPublished, "published")).toBe(
      entryTimestampByBasis(noPublished, "fetched"),
    );
    expect(
      buildTimelineRows([noPublished], {
        granularity: "hour",
        t,
        now,
        locale: "zh-CN",
        timeBasis: "fetched",
      }).filter((row) => row.kind === "entry"),
    ).toHaveLength(1);
  });

  it("默认档 = 发布时间：不传 timeBasis 与 published 逐行一致（升级零变化）", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 14, 10), {
        createdAt: localIso(2026, 9, 19, 8, 0),
      }),
      entry("b", localIso(2026, 9, 17, 9, 10), {
        createdAt: localIso(2026, 9, 19, 8, 5),
      }),
    ];
    for (const granularity of ["hour", "day"] as const) {
      const implicit = buildTimelineRows(entries, {
        granularity,
        t,
        now,
        locale: "zh-CN",
      });
      const explicit = buildTimelineRows(entries, {
        granularity,
        t,
        now,
        locale: "zh-CN",
        timeBasis: "published",
      });
      expect(implicit).toEqual(explicit);
    }
  });

  it("切抓取档：同批抓回的条目聚到同一天（分隔数变少），切回发布还原", () => {
    const entries = [
      entry("a", localIso(2026, 9, 10, 9, 0), {
        createdAt: localIso(2026, 9, 19, 8, 0),
      }),
      entry("b", localIso(2026, 9, 8, 9, 0), {
        createdAt: localIso(2026, 9, 19, 8, 2),
      }),
      entry("c", localIso(2026, 9, 7, 9, 0), {
        createdAt: localIso(2026, 9, 19, 8, 5),
      }),
    ];
    const pubDates = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
      timeBasis: "published",
    }).filter((row) => row.kind === "date");
    const fetchedDates = buildTimelineRows(entries, {
      granularity: "day",
      t,
      now,
      locale: "zh-CN",
      timeBasis: "fetched",
    }).filter((row) => row.kind === "date");
    // 发布档散在三天，抓取档聚在同一天（抓取日）
    expect(pubDates).toHaveLength(3);
    expect(fetchedDates).toHaveLength(1);
    expect(
      fetchedDates[0]?.kind === "date" && fetchedDates[0].key,
    ).toContain("2026-09-19");
  });

  it("展开簇的条目标注也走同一基准（传 timeBasis 进 expand）", () => {
    const rows = buildTimelineRows(
      ["a", "b", "c", "d", "e", "f"].map((id, index) =>
        entry(id, localIso(2026, 9, 17, 20 - index, 0), {
          createdAt: localIso(2026, 9, 19, 8, index),
        }),
      ),
      { granularity: "day", t, now, locale: "zh-CN", timeBasis: "fetched" },
    );
    const cluster = rows.find((row) => row.kind === "cluster");
    expect(cluster?.kind).toBe("cluster");
    const expanded = expandTimelineRows(rows, new Set([cluster!.key]), "fetched");
    const tail = expanded.slice(
      expanded.findIndex((row) => row.kind === "cluster") + 1,
    );
    // 抓取档下摊出来的三条都按 createdAt 标注。
    // 注意排序是 DESC（最新在上）：轴上是 f/e/d，被吸掉的是最旧的 c/b/a。
    expect(
      tail.map((row) => (row.kind === "entry" ? row.shortLabel : "x")),
    ).toEqual(["08:02", "08:01", "08:00"]);
  });
});

describe("timeline-model · 吸顶判定（33-2 只有吸顶那条才有浮起样式）", () => {
  it("只有正贴住线的那条算吸顶；还在线下方、以及已经滚过去的段，都不算", () => {
    const probes = [
      { key: "昨天", dateTop: -120, sectionTop: -700, sectionBottom: -8 }, // 整段滚过去了 → 不是它
      { key: "今天", dateTop: 0, sectionTop: -500, sectionBottom: 620 }, // 段跨着线 + 行贴线 → 是它
      { key: "更早", dateTop: 300, sectionTop: 300, sectionBottom: 900 }, // 还在线下方 → 不是它
    ];
    expect(pickStuckDateKeys(probes, 0)).toEqual(["今天"]);
  });

  it("交班瞬间两条都算：旧那条保持浮起直到被完全盖住（不闪透明）", () => {
    const probes = [
      { key: "22日", dateTop: -30, sectionTop: -900, sectionBottom: 12 }, // 正被推出去，段底刚过线
      { key: "21日", dateTop: 0, sectionTop: -60, sectionBottom: 500 }, // 刚贴上来
    ];
    expect(pickStuckDateKeys(probes, 0)).toEqual(["22日", "21日"]);
  });

  it("一个都不贴（刚进列表 / 空列表）→ 空数组，调用方据此不挂任何样式", () => {
    expect(pickStuckDateKeys([], 0)).toEqual([]);
    expect(
      pickStuckDateKeys([{ key: "今天", dateTop: 40, sectionTop: 40, sectionBottom: 800 }], 0),
    ).toEqual([]);
  });

  it("列表停最顶上：首段段顶正好等于线 → 不算吸顶（行保持裸文字）", () => {
    const probes = [
      { key: "今天", dateTop: 0, sectionTop: 0, sectionBottom: 620 },
      { key: "昨天", dateTop: 620, sectionTop: 620, sectionBottom: 1200 },
    ];
    expect(pickStuckDateKeys(probes, 0)).toEqual([]);
  });

  it("吸顶线非 0（容器滚动时用容器上沿）也成立", () => {
    const probes = [
      { key: "今天", dateTop: 64, sectionTop: -40, sectionBottom: 700 },
      { key: "昨天", dateTop: 64.4, sectionTop: 64, sectionBottom: 980 },
    ];
    expect(pickStuckDateKeys(probes, 64)).toEqual(["今天"]);
    expect(pickStuckDateKeys(probes, 0)).toEqual([]);
  });
});

describe("timeline-model · 日期分段（吸顶的作用域）", () => {
  it("按日期行切段：段头是日期、段内只剩内容行，一条不丢", () => {
    const entries = [
      entry("a", localIso(2026, 9, 18, 10, 0)),
      entry("b", localIso(2026, 9, 17, 10, 0)),
      entry("c", localIso(2026, 9, 16, 10, 0)),
    ];
    const today = new Date(localIso(2026, 9, 18, 12, 0)).getTime();
    const rows = buildTimelineRows(entries, {
      granularity: "hour",
      t,
      now: today,
      locale: "zh-CN",
    });
    const sections = splitTimelineSections(rows);
    expect(sections.map((section) => section.label)).toEqual([
      "timeline.today · 9月18日 周五",
      "timeline.yesterday · 9月17日 周四",
      "9月16日 周三",
    ]);
    // 内容行一条不落：段内行的总数 = 原行序列里非日期行（类型上段内已不含日期行）
    expect(sections.flatMap((section) => section.rows)).toHaveLength(
      rows.filter((row) => row.kind !== "date").length,
    );
  });

  it("首行不是日期行时兜底成一段，不丢行（半份数据也不炸）", () => {
    const sections = splitTimelineSections([
      {
        kind: "entry",
        key: "entry:x",
        entry: entry("x", localIso(2026, 9, 18, 10, 0)),
        side: "left",
        node: "major",
        label: "10:00",
        shortLabel: "10:00",
        bucket: "hour:2026-09-18T10",
        bucketCount: 1,
      },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections.at(0)?.label).toBe("");
    expect(sections.at(0)?.rows).toHaveLength(1);
  });
});

