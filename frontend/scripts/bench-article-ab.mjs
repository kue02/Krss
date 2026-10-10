/**
 * bench-article-ab.mjs —— 正文渲染 A/B 交错基准（生产构建）
 *
 * 两个已构建好的产物同时起在不同端口（before/after），在同一浏览器会话里**交错**测量，
 * 这样浏览器/JIT/机器负载的漂移对两边影响相同 —— 顺序测量会被噪声吃掉（本卡第一轮
 * 顺序测量的两组中位数 1480 vs 1112，换个顺序又变成 1587 vs 1471，完全重叠）。
 *
 * 用法（frontend 目录下）：
 *   ego-browser nodejs -e "$(cat scripts/bench-article-ab.mjs)"
 *
 * 产物从 A 到 B 的切换由外部负责（build 时 outDir 不同）：
 *   /api、/icons 同源代理到后端（vite.config.ts 的 preview.proxy），所以每个端口
 *   自己跑一份 vite preview 即可：
 *   KRSS_DEV_BACKEND=http://localhost:8083 bunx vite preview --port <p> --outDir <dir> --strictPort
 */
import { readFileSync, existsSync } from "node:fs";

const OV = globalThis.KRSS_BENCH || {};
const ENTRY = OV.entryId || "2108132336859090945";
const N = OV.n || 10;
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

const task = await taskSpace("krss 正文渲染 A/B 测速");
const page = task.page("p1");

// 逐 origin 建一次登录态（token 是同一个，两个端口各自的 localStorage 都要写）
for (const v of VARIANTS) {
  await page.goto(v.origin + "/");
  await page.evaluate((t) => localStorage.setItem("krss_auth_token", t), token);
}

async function measure(origin) {
  await page.goto(origin + LIST_PATH);
  // 必须 bringToFront：后台标签页 rAF 被节流到 ~1s/帧，会把量测搅成噪声。
  await page.cdp("Page.bringToFront");
  await page.waitForFunction((id) => !!document.querySelector(`[data-entry-id="${id}"]`), ENTRY, {
    timeout: 30000,
  });
  await page.waitForTimeout(800); // 列表安静（懒加载图片落定），保证每次起点一致

  return page.evaluate(async (id) => {
    const proseSel = () =>
      [...document.querySelectorAll("div")].find(
        (n) => n.querySelectorAll("p").length > 50 && (n.textContent || "").length > 20000,
      ) || null;

    const row = document.querySelector(`[data-entry-id="${id}"]`);
    (row.querySelector("a") || row).click();
    const t0 = performance.now();

    let firstPaintMs = null;
    const deadline = t0 + 40000;
    while (performance.now() < deadline) {
      const prose = proseSel();
      const p = prose && prose.querySelector("p");
      if (p && (p.textContent || "").trim()) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        firstPaintMs = Math.round(performance.now() - t0);
        break;
      }
      await new Promise((r) => setTimeout(r, 4));
    }
    const prose = proseSel();
    return {
      firstPaintMs,
      ps: prose ? prose.querySelectorAll("p").length : 0,
      textLen: prose ? (prose.textContent || "").length : 0,
      imgs: prose ? prose.querySelectorAll("img").length : 0,
    };
  }, ENTRY);
}

const results = Object.fromEntries(VARIANTS.map((v) => [v.name, []]));

// 预热：两边各跑 1 次不计入（首轮含 SW 注册 / 字体 / chunk 解压）
for (const v of VARIANTS) await measure(v.origin);

for (let i = 0; i < N; i++) {
  // 每轮交替先后顺序，抵消「谁总是先跑」的偏差
  const order = i % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    const r = await measure(v.origin);
    results[v.name].push(r.firstPaintMs);
    console.log(`round ${i + 1} ${v.name}: ${JSON.stringify(r)}`);
  }
}

const pct = (s, p) => {
  const a = [...s].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
};
console.log("\n=== A/B 结果（生产构建，同 warm / 同样本 / 同脚本 / 交错）===");
for (const v of VARIANTS) {
  const s = results[v.name].filter((x) => x != null);
  console.log(
    `${v.name.padEnd(7)} n=${s.length}  min=${pct(s, 0)}ms  p25=${pct(s, 0.25)}ms  ` +
      `median=${pct(s, 0.5)}ms  max=${pct(s, 1)}ms  raw=[${s.join(",")}]`,
  );
}
if (results.before.length && results.after.length) {
  const b = pct(results.before, 0.25);
  const a = pct(results.after, 0.25);
  console.log(
    `p25: ${b}ms → ${a}ms  (${(((a - b) / b) * 100).toFixed(1)}%)   ` +
      `min: ${pct(results.before, 0)}ms → ${pct(results.after, 0)}ms  ` +
      `(${(((pct(results.after, 0) - pct(results.before, 0)) / pct(results.before, 0)) * 100).toFixed(1)}%)`,
  );
}

await task.finish({ keep: [] });