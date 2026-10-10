/**
 * 护栏：**主包侧不许静态引入同步版语言检测**。
 *
 * 为什么值得为它单写一个测试：`@/lib/language-detect` 静态引入 `eld/small`
 * （语言模型的 n-gram 表，源码 ~1.5 MB）。谁把它静态拉进主包，整个 ELD 就进首屏 chunk，
 * 后果不是「大一点」而是**生产构建直接失败** —— 主 chunk 一旦超 2 MiB 就顶穿 PWA 的
 * workbox 预缓存上限，`bun run build` 报 `PLUGIN_ERROR: maximumFileSizeToCacheInBytes`，
 * 于是 Docker 镜像构建、GitHub 发版全挂。
 *
 * 2026-10-10 真踩过：`services/entry-prefetch-plan.ts`（在主包里）静态引了同步版，
 * 主 chunk **0.76 MiB → 2.31 MiB**（sourcemap 归因：`eld/src/ngrams/small.js` 1551 KB）。
 *
 * 规则：
 * - 主包侧一律走 `@/lib/language-detect-async`（内部动态 import，ELD 单独成 chunk）。
 * - 同步版只允许出现在**懒加载的正文页链路**里：那条链由
 *   `await import("@/components/entry-content")` 触发，进的是另一个 chunk。
 *
 * 这是**直接 import 的白名单检查**（不做模块图推导）：它拦不住「间接」把 ELD 拖进主包
 * 的写法，但正好拦得住已经踩过的那一脚，且零构建成本。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const SRC_DIR = join(process.cwd(), "src");

/** 懒加载正文页链路 —— 这几个文件静态引同步版是安全的（理由见文件头注释） */
const LAZY_GRAPH_WHITELIST = new Set([
  // 本体：由 language-detect-async 动态 import
  "lib/language-detect.ts",
  // 内部就是 `await import("./language-detect")`，自己不会把 ELD 拉进来
  "lib/language-detect-async.ts",
  // 只被 components/entry-content/EntryContent.tsx 引用，而 entry-content 是懒加载 chunk
  "hooks/useAITranslation.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_DIR).filter((f) => !/\.test\.(ts|tsx)$/.test(f));

/** `from "@/lib/language-detect"` / `import("@/lib/language-detect")` 两种写法 */
const STATIC_IMPORT_RE = /from\s+["']@\/lib\/language-detect["']/;
const DYNAMIC_IMPORT_RE = /import\(\s*["']@\/lib\/language-detect["']\s*\)/;

describe("语言检测的引入口径（ELD 不能进主包）", () => {
  it("静态引同步版 language-detect 的，只能是懒加载正文页链路上的文件", () => {
    const offenders = files
      .filter((f) => STATIC_IMPORT_RE.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_DIR, f))
      .filter((rel) => !LAZY_GRAPH_WHITELIST.has(rel));

    expect(
      offenders,
      `这些文件在主包侧静态引入了 @/lib/language-detect ⇒ ELD（~1.5 MB）会被打进首屏 chunk。` +
        `请改引 @/lib/language-detect-async（异步版）。`,
    ).toEqual([]);
  });

  it("动态 import 同步版的，只允许 language-detect-async 这一处", () => {
    const offenders = files
      .filter((f) => DYNAMIC_IMPORT_RE.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_DIR, f))
      .filter((rel) => rel !== "lib/language-detect-async.ts");

    expect(offenders).toEqual([]);
  });

  it("异步包装仍然存在且导出 needsTranslation（主包侧的入口）", () => {
    const src = readFileSync(
      join(SRC_DIR, "lib/language-detect-async.ts"),
      "utf8",
    );
    expect(src).toMatch(/export\s+async\s+function\s+needsTranslation/);
  });
});
