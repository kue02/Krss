/**
 * bench-article-first-paint.mjs —— 端到端「点击条目 → 正文首屏可见」基准（A/B 用）
 *
 * 需要 ego-browser 驱动真实浏览器，所以是 `.mjs` 脚本而不是 vitest 用例：
 *   cd frontend && ego-browser nodejs -e "$(cat scripts/bench-article-first-paint.mjs)"
 *
 * 脚本自己开一个 taskSpace、从 `.dev-credentials` 读 token 注入 localStorage，
 * 跑完 N 次测量后关闭 taskSpace——所以 shell 里的环境变量传不进来也没关系，
 * 要改参数请改下面的 DEFAULTS（或在 `-e` 里先注入 `globalThis.KRSS_BENCH = {...}`）。
 *
 * 为什么必须跑生产构建：vite dev 的冷转换会把点击耗时放大一个数量级
 * （实测 dev 下 14.2s vs preview 下 1.8s），dev 数字不能用来对话。
 * 前提是 vite.config.ts 里配了 preview.proxy（/api、/icons），否则同源请求全 404。
 *
 * 量两个指标（都在浏览器内判定，不用固定 sleep 猜）：
 *   firstPaintMs = 点击 → 正文第一段 <p> 有文本且跑过两帧 rAF（内容真的画出来了）
 *   fullBodyMs   = 点击 → 正文全部段落进入 DOM
 */
import { readFileSync, existsSync } from "node:fs";

const OV = globalThis.KRSS_BENCH || {};
const ORIGIN = OV.origin || "http://localhost:5188"; // vite preview
const LIST = OV.listUrl || `${ORIGIN}/feed/2102570001541107712?type=article`;
const ENTRY = OV.entryId || "2108132336859090945";
const N = OV.n || 5;
const CRED =
  OV.credentials ||
  // 逐级向上找本树的 .dev-credentials（worktree 布局因人而异，写死绝对路径不可移植）
  ["/Users/huyan/Documents/Projests/krss/.worktrees/render-speed", "/Users/huyan/Documents/Projests/krss"]
    .map((d) => `${d}/.dev-credentials`)
    .find((p) => existsSync(p));

const token = CRED && readFileSync(CRED, "utf8").match(/^BEARER_TOKEN=(.+)$/m)?.[1].trim();
if (!token) throw new Error(`BEARER_TOKEN not found (looked in ${CRED})`);

const task = await taskSpace("krss 正文渲染测速");
const page = task.page("p1");
await page.goto(ORIGIN + "/");
await page.evaluate((t) => localStorage.setItem("krss_auth_token", t), token);

const results = [];
for (let i = 0; i < N; i++) {
  await page.goto(LIST);
  await page.waitForFunction((id) => !!document.querySelector(`[data-entry-id="${id}"]`), ENTRY, {
    timeout: 20000,
  });
  // 等列表安静（懒加载图片落定），让每次起点一致
  await page.waitForTimeout(600);

  const r = await page.evaluate(async (id) => {
    // 正文容器：段落极多的那个 div（样本实测 1036 段 / 6.5 万字符）
    const proseSel = () =>
      [...document.querySelectorAll("div")].find(
        (n) => n.querySelectorAll("p").length > 50 && (n.textContent || "").length > 20000,
      ) || null;

    const row = document.querySelector(`[data-entry-id="${id}"]`);
    (row.querySelector("a") || row).click();
    const t0 = performance.now();

    let firstPaintMs = null;
    let fullBodyMs = null;
    const deadline = t0 + 40000;
    while (performance.now() < deadline) {
      const prose = proseSel();
      const p = prose && prose.querySelector("p");
      if (firstPaintMs == null && p && (p.textContent || "").trim()) {
        await new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2)));
        firstPaintMs = Math.round(performance.now() - t0);
      }
      if (fullBodyMs == null && prose && prose.querySelectorAll("p").length >= 1000) {
        fullBodyMs = Math.round(performance.now() - t0);
        break;
      }
      await new Promise((r2) => setTimeout(r2, 8));
    }
    const prose = proseSel();
    return {
      firstPaintMs,
      fullBodyMs,
      ps: prose ? prose.querySelectorAll("p").length : 0,
      textLen: prose ? (prose.textContent || "").length : 0,
      imgs: prose ? prose.querySelectorAll("img").length : 0,
    };
  }, ENTRY);
  results.push(r);
  console.log(`run ${i + 1}: ${JSON.stringify(r)}`);
}

const med = (a) => {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const fp = results.map((r) => r.firstPaintMs);
const fb = results.map((r) => r.fullBodyMs);
console.log(
  `FIRST-PAINT median ${med(fp)}ms  raw=[${fp.join(",")}]\n` +
    `FULL-BODY   median ${med(fb)}ms  raw=[${fb.join(",")}]  n=${N}  ` +
    `ps=${results[0]?.ps} textLen=${results[0]?.textLen} imgs=${results[0]?.imgs}`,
);

await task.finish({ keep: [] });