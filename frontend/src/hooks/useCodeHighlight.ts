import type { RefObject } from "react";
import { useEffect } from "react";
import { useUISettingKey } from "@/hooks/useUISettings";

type HighlightRuntimeModule = typeof import("@/lib/code-highlight-runtime");

let highlightRuntimePromise: Promise<HighlightRuntimeModule> | null = null;

async function getHighlightRuntime() {
  if (!highlightRuntimePromise) {
    highlightRuntimePromise = import("@/lib/code-highlight-runtime");
  }
  return highlightRuntimePromise;
}

function normalizeLanguage(lang: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    py: "python",
    sh: "bash",
    zsh: "bash",
    shellscript: "shell",
    yml: "yaml",
    htm: "html",
    plaintext: "text",
    text: "text",
    csharp: "csharp",
    cplusplus: "cpp",
    "c++": "cpp",
  };
  return aliases[lang.toLowerCase()] || lang.toLowerCase();
}

/**
 * 猜语言。
 *
 * 标准 markdown 给的是 `<code class="language-bash">`；
 * 而 WordPress / WP-Syntax 那类文章给的是 `<pre class="brush: bash; title: ; notranslate">`，
 * **没有 code 子元素** —— 这类块之前被整个跳过（既不高亮也没行号），见 BUG/待办记录。
 * 顺序：code 的 language-x → pre 的 language-x / lang-x / brush: x → pre 的 data-language。
 */
function detectLanguage(pre: HTMLElement, code: HTMLElement | null): string {
  const candidates = [
    code?.className ?? "",
    pre.className,
    pre.dataset.language ?? "",
  ];
  for (const value of candidates) {
    const languageMatch = /language-([a-z0-9_+-]+)/i.exec(value);
    if (languageMatch) return languageMatch[1]!;
    const shortMatch = /\blang-([a-z0-9_+-]+)/i.exec(value);
    if (shortMatch) return shortMatch[1]!;
    const brushMatch = /\bbrush:\s*([a-z0-9_+-]+)/i.exec(value);
    if (brushMatch) return brushMatch[1]!;
  }
  return "";
}

function createCopyButton(code: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className =
    "flex items-center justify-center p-1 bg-transparent text-muted-foreground rounded transition-colors hover:text-foreground hover:bg-foreground/10";
  button.type = "button";
  button.setAttribute("aria-label", "Copy code");
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      button.classList.add("!text-green-500");
      setTimeout(() => {
        button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
        button.classList.remove("!text-green-500");
      }, 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  });

  return button;
}

export function useCodeHighlight(
  containerRef: RefObject<HTMLElement | null>,
  content: string,
) {
  // 行号：整块代码统一加一个标记，具体样式由 CSS 计数器画（对齐 Nextflux 的 .line-numbers 做法）
  const showLineNumbers = useUISettingKey("showLineNumbers");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    for (const pre of container.querySelectorAll("pre")) {
      if (!(pre instanceof HTMLElement)) continue;
      if (showLineNumbers) pre.dataset.lineNumbers = "true";
      else delete pre.dataset.lineNumbers;
    }

    // 兼容两类代码块：带 <code> 的（标准 markdown 渲染）与**裸 <pre>**
    // （WordPress / WP-Syntax 那类文章：`<pre class="brush: bash">`，之前会被整个跳过）
    const blocks = Array.from(container.querySelectorAll("pre"));
    if (blocks.length === 0) return;

    let cancelled = false;

    async function highlightBlocks() {
      const { highlightCode } = await getHighlightRuntime();
      if (cancelled) return;

      for (const pre of blocks) {
        if (cancelled) break;
        if (!(pre instanceof HTMLElement)) continue;
        if (pre.dataset.shikiHighlighted) continue;

        // 裸 <pre>：先补一个 <code> 壳，之后 CSS（pre code）、行号、复制按钮都按同一套走
        let block = pre.querySelector(":scope > code");
        if (!block) {
          block = document.createElement("code");
          block.textContent = pre.textContent ?? "";
          pre.textContent = "";
          pre.appendChild(block);
        }
        if (!(block instanceof HTMLElement)) continue;

        const rawLang = detectLanguage(pre, block);
        const lang = rawLang ? normalizeLanguage(rawLang) : "text";

        const code = block.textContent || "";
        if (!code.trim()) continue;

        if (cancelled) break;

        try {
          const html = await highlightCode(code, lang);

          const temp = document.createElement("div");
          temp.innerHTML = html;
          const newPre = temp.querySelector("pre");
          if (newPre) {
            const newCode = newPre.querySelector("code");
            if (newCode) {
              block.innerHTML = newCode.innerHTML;
              block.className = newCode.className;
            }
            pre.className = `${pre.className} ${newPre.className}`.trim();

            // Set data-language attribute for CSS targeting (rehype-pretty-code compatible)
            if (rawLang) {
              pre.dataset.language = rawLang;
            }

            // Add header with language label and copy button
            if (!pre.querySelector("[data-code-header]")) {
              const header = document.createElement("div");
              header.className =
                "flex items-center justify-end px-4 py-2 border-b border-border bg-transparent";
              header.dataset.codeHeader = "true";

              if (rawLang) {
                const langSpan = document.createElement("span");
                langSpan.className =
                  "mr-auto font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground";
                langSpan.textContent = rawLang;
                header.appendChild(langSpan);
              }

              const copyBtn = createCopyButton(code);
              header.appendChild(copyBtn);

              pre.insertBefore(header, pre.firstChild);
            }

            if (showLineNumbers) pre.dataset.lineNumbers = "true";
            pre.dataset.shikiHighlighted = "true";
          }
        } catch {
          // 高亮失败也要把行号开关落上去：至少代码是可读的，行号不该跟着一起消失
          if (showLineNumbers) pre.dataset.lineNumbers = "true";
          pre.dataset.shikiHighlighted = "true";
        }
      }
    }

    highlightBlocks();

    return () => {
      cancelled = true;
    };
  }, [containerRef, content, showLineNumbers]);
}
