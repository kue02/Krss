// bench-parse-ab.mjs —— parse-html 两版**同进程交错**对照（before=每调用重建 schema/管线，after=模块级单例）
//
// 为什么必须交错：两版顺序跑受 JIT/GC/机器负载影响太大（实测顺序两轮 median
// 69.4ms vs 42.6ms，min 13.0 vs 16.8，完全对不上），同进程交错才量得出真实差。
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const HERE = new URL("..", import.meta.url).pathname; // frontend/ 绝对路径
const SAMPLE = `${HERE}.bench-samples/sample.html`;
const html = readFileSync(SAMPLE, "utf8");

// before 版 = 基线 356b4b0 的实现，落到临时模块（与 after 同目录，相对 import 才成立）
const { execSync } = await import("node:child_process");
const BEFORE_PATH = `${HERE}src/lib/__ab-before.ts`;
writeFileSync(
  BEFORE_PATH,
  execSync("git show 356b4b0:frontend/src/lib/parse-html.ts", {
    cwd: "..",
    encoding: "utf8",
  }),
);

const before = await import(BEFORE_PATH);
const after = await import(`${HERE}src/lib/parse-html.ts`);

const VARIANTS = [
  { name: "before(每次重建)", fn: before.parseHtml },
  { name: "after (模块级单例)", fn: after.parseHtml },
];

// 预热：两版各跑 5 次（模块初始化 + JIT），不计入
for (const v of VARIANTS) for (let i = 0; i < 5; i++) v.fn(html).toContent();

const N = Number(process.argv[2] || 41);
const times = Object.fromEntries(VARIANTS.map((v) => [v.name, []]));
for (let i = 0; i < N; i++) {
  const order = i % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    const t0 = performance.now();
    v.fn(html).toContent();
    times[v.name].push(performance.now() - t0);
  }
}

const pct = (s, p) => {
  const a = [...s].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
};
console.log(`sample chars=${html.length} n=${N} (交错，同进程)`);
for (const v of VARIANTS) {
  const s = times[v.name];
  console.log(
    `${v.name.padEnd(18)} min=${pct(s, 0).toFixed(2)}  p25=${pct(s, 0.25).toFixed(2)}  ` +
      `median=${pct(s, 0.5).toFixed(2)}  p75=${pct(s, 0.75).toFixed(2)}  max=${pct(s, 1).toFixed(2)}  (ms)`,
  );
}
const b = pct(times[VARIANTS[0].name], 0.5);
const a = pct(times[VARIANTS[1].name], 0.5);
console.log(
  `median ${b.toFixed(2)}ms → ${a.toFixed(2)}ms  (${(((a - b) / b) * 100).toFixed(1)}%, 省 ${(b - a).toFixed(2)}ms/次)`,
);