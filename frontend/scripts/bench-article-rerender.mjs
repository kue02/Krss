/**
 * bench-article-rerender.mjs —— 正文视图**重渲染**开销基准（A/B 用）
 *
 * 为什么单独量这个：click → 首屏那条路径只渲染一次，`ArticleContent` 的 images memo
 * 依赖从 `[props, articleUrl]`（props 每次新对象）改成 `[content, blocks, articleUrl]`
 * 在这条路径上省不到什么——本卡实测端到端首屏在噪声里（交错 A/B p25 1304 → 1377ms）。
 * 真正被它救的是**重渲染**：滚动（阅读进度条等状态）时父组件重渲染，
 * 改动前每帧都把整篇正文的 `<img>` 正则扫描重跑一遍（104k 字符 / 3 img）。
 *
 * 量法：打开正文 → 滚到底再滚回（触发若干次父级重渲染）→ 用 PerformanceObserver
 * 收 longtask（≥50ms 的主线程阻塞）。同时记录滚动总耗时，两边同 warm / 同样本 / 交错。
 *
 * 用法（frontend 目录下，两个 preview 分别在 5188/5189）：
 *   ego-browser nodejs -e "$(cat scripts/bench-article-rerender.mjs)"
 */
import { readFileSync, existsSync } from "node:fs";

const OV = globalThis.KRSS_BENCH || {};
const ENTRY = OV.entryId || "2108132336859090945";
const N = OV.n || 6;
const LIST_PATH = OV.listPath || `/feed/2102570001541107712?type=article`;
const VARIANTS = OV.variants || [
  { name: "before", origin: OV.beforeOrigin || "http://localhost:5188" },
  { name: "after", origin: OV.afterOrigin || "http://localhost:5189" },
];
const CRED =
  OV.credentials ||
  [
    "/Users/huyan/Documents/Projests/krss/.worktrees/render-speed",
    "/Users/huyan/Documents/Projests/krss",
  ]
    .map((d) => `${d}/.dev-credentials`)
    .find((p) => existsSync(p));

const token = CRED && readFileSync(CRED, "utf8").match(/^BEARER_TOKEN=(.+)$/m)?.[1].trim();
if (!token) throw new Error(`BEARER_TOKEN not found (looked in ${CRED})`);

const task = await taskSpace("krss 正文重渲染 A/B 测速");
const page = task.page("p1");
for (const v of VARIANTS) {
  await page.goto(v.origin + "/");
  await page.evaluate((t) => localStorage.setItem("krss_auth_token", t), token);
}

async function measure(origin) {
  await page.goto(origin + LIST_PATH);
  // **必须 bringToFront**：后台标签页里 rAF 被节流到 ~1s/帧（实测 513/904/27…），
  // 不 foreground 的话「逐帧滚动」量的是节流不是渲染成本。
  await page.cdp("Page.bringToFront");
  await page.waitForFunction((id) => !!document.querySelector(`[data-entry-id="${id}"]`), ENTRY, {
    timeout: 30000,
  });
  await page.waitForTimeout(800);
  const box = await page.evaluate((id) => {
    const row = document.querySelector(`[data-entry-id="${id}"]`);
    const el = (row && (row.querySelector("a") || row)) || null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, ENTRY);
  if (!box) throw new Error("entry row not clickable");
  await page.mouse.click(box.x, box.y, { label: "打开条目正文" });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("div")].some(
        (n) => n.querySelectorAll("p").length > 50 && (n.textContent || "").length > 20000,
      ),
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200); // 正文落定、图片开始懒加载后再开始量

  return page.evaluate(async () => {
    const longtasks = [];
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longtasks.push(Math.round(e.duration));
    });
    obs.observe({ entryTypes: ["longtask"] });

    const scroller = (() => {
      // 正文所在的滚动容器（不是 window 的话 window.scrollTo 不起作用）
      const prose = [...document.querySelectorAll("div")].find(
        (n) => n.querySelectorAll("p").length > 50 && (n.textContent || "").length > 20000,
      );
      let el = prose;
      while (el && el.scrollHeight <= el.clientHeight + 10) el = el.parentElement;
      return el && el.scrollHeight > el.clientHeight ? el : document.scrollingElement;
    })();

    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const max = scroller.scrollHeight - scroller.clientHeight;

    // 逐帧量帧耗时（滚动一帧的成本才是我们关心的），并设**页内硬预算 12s**：
    // page.evaluate 有 15s 硬超时，正文滚动重绘很重，无预算会量不完。
    // 预算内能跑多少帧就跑多少，两边帧数可能不同 → 同时报 fps 让对比有依据。
    const frameMs = [];
    const t0 = performance.now();
    const BUDGET = 12000;
    while (frameMs.length < 120 && performance.now() - t0 < BUDGET) {
      const i = frameMs.length;
      const trip = Math.floor(i / 12);
      const step = i % 12;
      const dir = trip % 2 === 0 ? 1 : -1;
      const f0 = performance.now();
      scroller.scrollTop = dir > 0 ? (max * (step + 1)) / 12 : (max * (11 - step)) / 12;
      await raf();
      frameMs.push(performance.now() - f0);
    }
    const scrollMs = Math.round(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 200));
    obs.disconnect();

    const s = [...frameMs].sort((a, b) => a - b);
    return {
      scrollMs,
      frames: frameMs.length,
      frameMedian: Math.round(s[Math.floor(s.length / 2)]),
      frameP90: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]),
      longtasks: longtasks.length,
      longtaskMs: longtasks.reduce((a, b) => a + b, 0),
      worstLongtask: longtasks.length ? Math.max(...longtasks) : 0,
      longtaskList: longtasks,
    };
  });
}

const results = Object.fromEntries(VARIANTS.map((v) => [v.name, []]));
for (const v of VARIANTS) await measure(v.origin); // 预热

for (let i = 0; i < N; i++) {
  const order = i % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    const r = await measure(v.origin);
    results[v.name].push(r);
    console.log(
      `round ${i + 1} ${v.name}: frames=${r.frames} scrollMs=${r.scrollMs} ` +
        `frameMedian=${r.frameMedian}ms frameP90=${r.frameP90}ms ` +
        `longtasks=${r.longtasks} longtaskMs=${r.longtaskMs} worst=${r.worstLongtask}ms  ` +
        `list=[${r.longtaskList.join(",")}]`,
    );
  }
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
console.log("\n=== 重渲染 A/B（滚动直到页内 12s 预算耗尽，指标取中位数）===");
for (const v of VARIANTS) {
  const rs = results[v.name];
  console.log(
    `${v.name.padEnd(7)} frames=${med(rs.map((r) => r.frames))}  ` +
      `scrollMs=${med(rs.map((r) => r.scrollMs))}  ` +
      `frameMedian=${med(rs.map((r) => r.frameMedian))}ms  ` +
      `frameP90=${med(rs.map((r) => r.frameP90))}ms  ` +
      `longtasks=${med(rs.map((r) => r.longtasks))}  ` +
      `longtaskMs=${med(rs.map((r) => r.longtaskMs))}  ` +
      `worst=${med(rs.map((r) => r.worstLongtask))}ms`,
  );
}

await task.finish({ keep: [] });