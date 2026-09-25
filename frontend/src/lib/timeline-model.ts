/**
 * 通知视图 · 时间线的纯逻辑层（第十五批 15-1/15-2）。
 *
 * 这里只做「条目 → 轴上的行」这件事：分桶（粒度四档）、跨天插日期分隔、
 * 卡片的左右交替、以及密集条目吸成「小节点 + 计数」。
 * 不碰 React、不发请求 —— 分页仍是列表那套 limit+1，粒度只影响分组与节点标注。
 */

import type { Entry } from "@/types/api";

type TranslateFunction = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/** 粒度四档（15-2 拍板：精确到分 / 每 15 分钟 / 每小时（默认）/ 每天） */
export type TimelineGranularity = "minute" | "quarter" | "hour" | "day";

export const TIMELINE_GRANULARITIES: readonly TimelineGranularity[] = [
  "minute",
  "quarter",
  "hour",
  "day",
];

/** 拍板默认「每小时」 */
export const DEFAULT_TIMELINE_GRANULARITY: TimelineGranularity = "hour";

/**
 * 时间基准两档（26-2 重做，2026-09-24）：
 *   published = 按文章发布时间（`publishedAt`，缺失退回 `createdAt`）—— 现状语义，默认档；
 *   fetched   = 按本机抓取时间（`createdAt` = 入库时间 = 刷新批次，缺失退回 `publishedAt`）。
 * 缺对应时间的条目退回另一个，**不得丢条目**。
 */
export type TimelineTimeBasis = "published" | "fetched";

export const TIMELINE_TIME_BASES: readonly TimelineTimeBasis[] = [
  "published",
  "fetched",
];

/** 拍板默认「发布时间」（= 现状，升级零变化） */
export const DEFAULT_TIMELINE_TIME_BASIS: TimelineTimeBasis = "published";

/**
 * 折叠档位（15-3 拍板：默认折叠、折叠 2 行，档位 1/2/3/全文）。
 * `full` = 不折叠（正文全量显示，"展开"变成一个空操作）。
 */
export type TimelineCollapse = "1" | "2" | "3" | "full";

export const TIMELINE_COLLAPSES: readonly TimelineCollapse[] = [
  "1",
  "2",
  "3",
  "full",
];

export const DEFAULT_TIMELINE_COLLAPSE: TimelineCollapse = "2";

/**
 * 窄栏退化阈值：时间线容器宽度**小于**这个值就退化成单侧时间线
 * （左时间列 + 右卡片，移动端就是这个形态）。
 * 768 对齐移动端断点（`MOBILE_BREAKPOINT` / `SETTINGS_MOBILE_BREAKPOINT`）——
 * 用户反馈：桌面两栏后容器恒宽 65ch，385 的旧阈值永远触发不了，「合一栏跟没了似的」。
 * 关掉「窄栏合一栏」设置则始终左右交替。
 */
export const TIMELINE_SINGLE_SIDE_WIDTH = 768;

/** 同一时间桶里最多平铺几张卡，再多就吸成「小节点 + 计数」（可点开，就地展开） */
export const TIMELINE_BUCKET_CARD_LIMIT = 3;

/** 至少要吸掉这么多条才值得收起来（只吸 1 条会让人白多点一次） */
export const TIMELINE_CLUSTER_MIN = 2;

export type TimelineSide = "left" | "right";
/** major = 这个桶的头节点（带粒度标注）；minor = 同桶里的后续条目（小节点） */
export type TimelineNodeKind = "major" | "minor";

export interface TimelineDateRow {
  kind: "date";
  key: string;
  /** 今天 / 昨天 / 9月16日 周二 */
  label: string;
}

export interface TimelineEntryRow {
  kind: "entry";
  key: string;
  entry: Entry;
  side: TimelineSide;
  node: TimelineNodeKind;
  /** 紧贴节点的标注：头节点给粒度桶的时间，后续条目给自己的精确时间 */
  label: string;
  /**
   * C-②：单侧列（76px）放不下「9月18日 周五 22:00」这种跨天全标 ——
   * shortLabel 只留 HH:MM（日期看跨天分隔头），渲染层 singleSide 时用它。
   */
  shortLabel: string;
  /** 所在时间桶的 key（展开态、调试定位都用它） */
  bucket: string;
  /** 这个桶里一共有多少条（含被吸进小节点的）—— 头节点上挂「N 条」用它 */
  bucketCount: number;
}

export interface TimelineClusterRow {
  kind: "cluster";
  key: string;
  side: TimelineSide;
  /** 被吸掉的条数（不含平铺出来的那几张） */
  count: number;
  entries: Entry[];
}

export type TimelineRow = TimelineDateRow | TimelineEntryRow | TimelineClusterRow;

/** 段内的行：日期行已经提出来当段头了，段里只剩内容行 */
export type TimelineContentRow = TimelineEntryRow | TimelineClusterRow;

/** 日期段：一条日期分隔行 + 它下面到下一个日期行之前的行（= 吸顶的作用域） */
export interface TimelineSection {
  key: string;
  label: string;
  rows: TimelineContentRow[];
}

/**
 * 按日期行切段（用户 9-24 吸顶）。
 *
 * 为什么非切不可：原生 `position: sticky` 的作用域是元素的**包含块**。日期行若全是同一个
 * 容器的兄弟节点，多个 `top: 0` 的 sticky 元素会互相重叠 —— 实测 26 个日期行全部贴在容器
 * 顶部（「整摞贴住」），而不是"后一条顶掉前一条"。给每一段套一层容器后，日期行只能在自己
 * 那一段里吸：本段滚完被段底边推走，下一段的日期行接替 —— 这才是换班，且零 JS 监听。
 */
export function splitTimelineSections(
  rows: readonly TimelineRow[],
): TimelineSection[] {
  const sections: TimelineSection[] = [];
  for (const row of rows) {
    if (row.kind === "date") {
      sections.push({ key: row.key, label: row.label, rows: [] });
      continue;
    }
    let current = sections.at(-1);
    if (!current) {
      // 兜底：正常列表首行必是日期行；真遇到半份数据也不丢行
      current = { key: "day:unknown", label: "", rows: [] };
      sections.push(current);
    }
    current.rows.push(row);
  }
  return sections;
}

/** 认不出来的值一律回默认档（服务端/导入回来的半份配置不会把界面读崩） */
export function resolveTimelineGranularity(value: unknown): TimelineGranularity {
  return TIMELINE_GRANULARITIES.includes(value as TimelineGranularity)
    ? (value as TimelineGranularity)
    : DEFAULT_TIMELINE_GRANULARITY;
}

/** 认不出的时间基准一律回「发布时间」（= 现状） */
export function resolveTimelineTimeBasis(value: unknown): TimelineTimeBasis {
  return TIMELINE_TIME_BASES.includes(value as TimelineTimeBasis)
    ? (value as TimelineTimeBasis)
    : DEFAULT_TIMELINE_TIME_BASIS;
}

export function resolveTimelineCollapse(value: unknown): TimelineCollapse {
  return TIMELINE_COLLAPSES.includes(value as TimelineCollapse)
    ? (value as TimelineCollapse)
    : DEFAULT_TIMELINE_COLLAPSE;
}

/** 折叠档位 → CSS 行数；`null` = 全文（不折） */
export function timelineCollapseClampLines(
  value: TimelineCollapse,
): number | null {
  return value === "full" ? null : Number(value);
}

/** 窄栏判定（< 768px 即移动端宽度，真退化成单侧） */
export function isSingleSideWidth(width: number): boolean {
  return width > 0 && width < TIMELINE_SINGLE_SIDE_WIDTH;
}

/** 条目在轴上的时间基准：没有 publishedAt 的条目退回 createdAt */
export function entryTimestamp(entry: Entry): number {
  return entryTimestampByBasis(entry, DEFAULT_TIMELINE_TIME_BASIS);
}

/**
 * 按时间基准取条目的轴上时间（26-2 重做）：
 *   published = `publishedAt || createdAt`（现状语义）；
 *   fetched   = `createdAt || publishedAt`（本机抓取时间 = 刷新批次）。
 * 任一档缺对应时间都退回另一个，**不得丢条目**。
 */
export function entryTimestampByBasis(
  entry: Entry,
  basis: TimelineTimeBasis,
): number {
  const raw =
    basis === "fetched"
      ? entry.createdAt || entry.publishedAt
      : entry.publishedAt || entry.createdAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 按粒度把时间对齐到所在桶的起点（本地时区） */
export function bucketStartMs(
  ms: number,
  granularity: TimelineGranularity,
): number {
  const date = new Date(ms);
  date.setMilliseconds(0);
  date.setSeconds(0);
  if (granularity === "minute") return date.getTime();
  date.setMinutes(granularity === "quarter" ? date.getMinutes() - (date.getMinutes() % 15) : 0);
  if (granularity === "quarter" || granularity === "hour") return date.getTime();
  date.setHours(0);
  return date.getTime();
}

/** 桶的稳定 key（用于 React key 与「哪个小节点展开了」这份状态） */
export function bucketKey(
  ms: number,
  granularity: TimelineGranularity,
): string {
  return `${granularity}:${bucketStartMs(ms, granularity)}`;
}

/** 本地日历日 key（跨天插分隔用它判边界） */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** 精确到分的时间（小节点标注、卡片元信息都用它） */
export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 日期分隔 / 每天粒度的标注：今天 / 昨天 / 9月16日 周二 */
/** 中文数字（1→一、10→十、14→十四、24→二十四），用于「九月十四日」这类完整日期 */
const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
export function chineseNumber(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 99) return String(value);
  if (value < 10) return CN_DIGITS[value] ?? String(value);
  if (value === 10) return "十";
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  const head = tens === 1 ? "十" : `${CN_DIGITS[tens]}十`;
  return ones === 0 ? head : `${head}${CN_DIGITS[ones]}`;
}

/**
 * 日期分隔行文案（用户 9-24）：要能一眼读出「几月几号」——
 * 中文写成完整全称「九月十四日 周一」；今天/昨天在最前面带相对词
 * （「今天 · 九月二十四日 周三」），吸顶时既知道是哪天、也知道是几号。
 */
export function formatDayLabel(
  ms: number,
  now: number,
  t: TranslateFunction,
  locale?: string,
): string {
  const date = new Date(ms);
  const isZh = (locale ?? "").toLowerCase().startsWith("zh");
  const full = isZh
    ? `${chineseNumber(date.getMonth() + 1)}月${chineseNumber(date.getDate())}日 周${"日一二三四五六"[date.getDay()]}`
    : date.toLocaleDateString(locale, {
        month: "long",
        day: "numeric",
        weekday: "short",
      });
  const dayKey = localDayKey(ms);
  if (dayKey === localDayKey(now)) return `${t("timeline.today")} · ${full}`;
  if (dayKey === localDayKey(now - 24 * 60 * 60 * 1000)) {
    return `${t("timeline.yesterday")} · ${full}`;
  }
  return full;
}

/** 头节点（桶）的标注：按粒度给「桶名」，跨天时补上日期 */
export function formatBucketLabel(
  ms: number,
  granularity: TimelineGranularity,
  now: number,
  t: TranslateFunction,
  locale?: string,
): string {
  if (granularity === "day") return formatDayLabel(ms, now, t, locale);
  const clock = formatClockTime(bucketStartMs(ms, granularity));
  const dayKey = localDayKey(ms);
  if (dayKey === localDayKey(now)) return clock;
  return `${formatDayLabel(ms, now, t, locale)} ${clock}`;
}

export interface BuildTimelineOptions {
  granularity: TimelineGranularity;
  t: TranslateFunction;
  /** "now" 注入进来是为了可测（今天/昨天的判定） */
  now?: number;
  locale?: string;
  /** 同一桶里最多平铺几张卡（默认 3） */
  maxPerBucket?: number;
  /** 时间基准（默认发布时间 = 现状；抓取时间 = 本机抓取/刷新批次） */
  timeBasis?: TimelineTimeBasis;
}

/**
 * 条目 → 轴上的行序列。**最新在上**（列表本来就是 published_at DESC，这里再排一次是防御）。
 *
 * 行的构成：
 *   - `date`    跨天时插一条日期分隔；
 *   - `entry`   一条条目，带左右侧与节点档位（桶的第一条是 major，带粒度标注）；
 *   - `cluster` 同一个桶里太密集时，多出来的条目吸成一个小节点 + 计数（点开就地展开）。
 */
export function buildTimelineRows(
  entries: Entry[],
  {
    granularity,
    t,
    now = Date.now(),
    locale,
    maxPerBucket = TIMELINE_BUCKET_CARD_LIMIT,
    timeBasis = DEFAULT_TIMELINE_TIME_BASIS,
  }: BuildTimelineOptions,
): TimelineRow[] {
  const basis = resolveTimelineTimeBasis(timeBasis);
  const stamp = (entry: Entry) => entryTimestampByBasis(entry, basis);
  const sorted = entries
    .map((entry, index) => ({ entry, index, at: stamp(entry) }))
    .sort((a, b) => (b.at - a.at) || (a.index - b.index));

  /** 先按桶分组，再决定每个桶里平铺几条、吸几条 */
  const groups: { key: string; entries: { entry: Entry; at: number }[] }[] = [];
  for (const item of sorted) {
    const key = bucketKey(item.at, granularity);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(item);
    } else {
      groups.push({ key, entries: [item] });
    }
  }

  const rows: TimelineRow[] = [];
  /** 左右交替的序号：日期分隔不占位（它只在轴上居中显示） */
  let sideIndex = 0;
  const nextSide = (): TimelineSide =>
    sideIndex++ % 2 === 0 ? "left" : "right";
  let lastDay: string | null = null;

  for (const group of groups) {
    const first = group.entries[0];
    if (!first) continue;

    // 跨天：先插日期分隔（同一天的正午/整点桶永远同一天，所以按桶的首条判即可）
    const dayKey = localDayKey(first.at);
    if (dayKey !== lastDay) {
      rows.push({
        kind: "date",
        key: `day:${dayKey}`,
        label: formatDayLabel(first.at, now, t, locale),
      });
      lastDay = dayKey;
    }

    const clustered =
      group.entries.length - maxPerBucket >= TIMELINE_CLUSTER_MIN;
    const visible = clustered
      ? group.entries.slice(0, maxPerBucket)
      : group.entries;
    const absorbed = clustered ? group.entries.slice(maxPerBucket) : [];

    visible.forEach((item, index) => {
      rows.push({
        kind: "entry",
        key: `entry:${item.entry.id}`,
        entry: item.entry,
        side: nextSide(),
        node: index === 0 ? "major" : "minor",
        label:
          index === 0
            ? formatBucketLabel(item.at, granularity, now, t, locale)
            : formatClockTime(item.at),
        // C-②：单侧列只留 HH:MM（头节点也只取钟点，日期看分隔头）
        shortLabel: formatClockTime(
          index === 0 ? bucketStartMs(item.at, granularity) : item.at,
        ),
        bucket: group.key,
        // 头节点上的「N 条」= 整个桶的条数（平铺的 + 被吸进小节点的）
        bucketCount: group.entries.length,
      });
    });

    if (absorbed.length > 0) {
      rows.push({
        kind: "cluster",
        key: `cluster:${group.key}`,
        side: nextSide(),
        count: absorbed.length,
        entries: absorbed.map((item) => item.entry),
      });
    }
  }

  return rows;
}

/**
 * 把「展开了的小节点」摊开：**小节点本身留着**，它的条目就地插在它下面。
 *
 * 为什么保留小节点：摊开之后还要能收回去（否则点一下就再也合不上）。
 * 位置也正好是「就地展开」—— 小节点在轴上的位置一点不动，多的卡片往下长。
 * 摊出来的条目沿用那一簇的左右侧、之后左右交替。
 */
export function expandTimelineRows(
  rows: TimelineRow[],
  expandedClusterKeys: ReadonlySet<string>,
  timeBasis: TimelineTimeBasis = DEFAULT_TIMELINE_TIME_BASIS,
): TimelineRow[] {
  if (expandedClusterKeys.size === 0) return rows;

  const basis = resolveTimelineTimeBasis(timeBasis);
  const stamp = (entry: Entry) => entryTimestampByBasis(entry, basis);
  const out: TimelineRow[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.kind !== "cluster" || !expandedClusterKeys.has(row.key)) continue;

    row.entries.forEach((entry, index) => {
      out.push({
        kind: "entry",
        key: `entry:${entry.id}`,
        entry,
        side: index % 2 === 0 ? row.side : row.side === "left" ? "right" : "left",
        node: "minor",
        label: formatClockTime(stamp(entry)),
        shortLabel: formatClockTime(stamp(entry)),
        bucket: row.key,
        bucketCount: row.entries.length,
      });
    });
  }
  return out;
}
