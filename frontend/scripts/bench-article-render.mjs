/**
 * bench-article-render.mjs —— 正文渲染耗时基准（解析侧，A/B 可复现）
 *
 * 用法（在 `frontend` 目录下跑）：
 *   bun scripts/bench-article-render.mjs                  # 默认 parseHtml + toContent
 *   bun scripts/bench-article-render.mjs --repeat 15
 *   bun scripts/bench-article-render.mjs --full           # 额外拆 sanitize / linkify 阶段
 *   bun scripts/bench-article-render.mjs --sample <path>  # 换样本
 *
 * 样本默认取 `frontend/.bench-samples/sample.html`。**样本不入库**（`.git/info/exclude`
 * 里排掉了 `.bench-samples/`：这是公开仓库，抓下来的真实正文不能提交进去）。
 * 重新生成样本（在仓库根目录跑，数据是真实副本库 data-render，不是真库）：
 *   mkdir -p frontend/.bench-samples
 *   sqlite3 ~/Documents/Docker/krss/data/data-render/krss.db \
 *     "select content from entries where id=2108132336859090945" \
 *     > frontend/.bench-samples/sample.html
 *
 * 该条目是副本库里最长的正文之一：104074 字符 / 1036 段 / 47 div / 3 img。
 * 副本库全库 2348 条有正文的条目、平均只有 1713 字符，所以这个样本是**尾部**，
 * 不是典型值——典型文章的 parse 成本远低于此。
 *
 * 注意：这里只量 **解析侧**（parseHtml → React 元素树）。DOM 挂载与布局不在此列，
 * 端到端首屏请用生产构建（`bun run build` + `vite preview`）在浏览器里量。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = resolve(HERE, "../.bench-samples/sample.html");

function parseArgs(argv) {
  const args = { repeat: 9, full: false, sample: DEFAULT_SAMPLE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repeat") args.repeat = Number(argv[++i]) || 9;
    else if (a === "--full") args.full = true;
    else if (a === "--sample") args.sample = argv[++i];
  }
  return args;
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s[s.length - 1],
  };
}

const { repeat, full, sample } = parseArgs(process.argv.slice(2));

if (!existsSync(sample)) {
  console.error(`sample not found: ${sample}`);
  console.error(
    "重新生成：sqlite3 ~/Documents/Docker/krss/data/data-render/krss.db " +
      '"select content from entries where id=2108132336859090945" > frontend/.bench-samples/sample.html',
  );
  process.exit(1);
}

const html = readFileSync(sample, "utf8");
const { parseHtml } = await import("../src/lib/parse-html.ts");

console.log(
  `sample: ${sample}\nchars: ${html.length}  imgs: ${(html.match(/<img/gi) || []).length}  pre: ${(html.match(/<pre/gi) || []).length}`,
);

// 先跑一次把 JIT 热起来，再量——否则第一个样本会被模块初始化 + JIT 编译吃掉
for (let i = 0; i < 3; i++) parseHtml(html).toContent();

const times = [];
for (let i = 0; i < repeat; i++) {
  const t0 = performance.now();
  parseHtml(html).toContent();
  times.push(performance.now() - t0);
}
const t = stats(times);
console.log(
  `parseHtml+toContent  median ${t.median.toFixed(1)}ms  (min ${t.min.toFixed(1)} / max ${t.max.toFixed(1)}, n=${repeat})`,
);

if (full) {
  const { unified } = await import("unified");
  const rehypeParse = (await import("rehype-parse")).default;
  const rehypeSanitize = (await import("rehype-sanitize")).default;
  const { defaultSchema } = await import("rehype-sanitize");
  const rehypeStringify = (await import("rehype-stringify")).default;
  const { rehypeLinkifyBareUrls } = await import("../src/lib/rehype-linkify.ts");

  const stage = (use, n = 5) => {
    const ts = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      let p = unified().use(rehypeParse, { fragment: true });
      if (use.sanitize) p = p.use(rehypeSanitize, { ...defaultSchema });
      if (use.linkify) p = p.use(rehypeLinkifyBareUrls);
      if (use.stringify) p = p.use(rehypeStringify);
      const tree = p.runSync(p.parse(html), html);
      ts.push(performance.now() - t0);
      void tree;
    }
    return stats(ts).median;
  };

  console.log(`  stage parse only          ${stage({}).toFixed(1)}ms`);
  console.log(`  stage +sanitize           ${stage({ sanitize: true }).toFixed(1)}ms`);
  console.log(`  stage +sanitize+linkify   ${stage({ sanitize: true, linkify: true }).toFixed(1)}ms`);
  console.log(
    `  stage +sanitize+linkify+stringify ${stage({ sanitize: true, linkify: true, stringify: true }).toFixed(1)}ms`,
  );
}