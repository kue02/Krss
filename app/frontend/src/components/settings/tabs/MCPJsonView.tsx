import { useMemo } from "react";
import { Code, ScrollShadow } from "@heroui/react";
import { cn } from "@/lib/utils";
import { tokenizeJSON, type MCPJsonTokenKind } from "@/lib/mcp";

/**
 * 只读 JSON/文本展示（16-13 口径）：`Code` 包在 `ScrollShadow` 里 +
 * 自写小 tokenizer 上色。四色用现有主题 token，不新造色：
 * key=accent / string=绿 / number=琥珀 / literal=紫 / 标点=次要文字。
 * 不做「边打字边高亮」—— 编辑走 MCPJsonEditor（TextArea），这里只读。
 */
const TOKEN_CLASS: Record<MCPJsonTokenKind, string> = {
  key: "text-accent",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  literal: "text-violet-700 dark:text-violet-300",
  punct: "text-muted-foreground",
};

interface MCPJsonViewProps {
  code: string;
  /** 最大高度（超出内部滚动，ScrollShadow 给上下阴影暗示） */
  maxHeight?: string;
  className?: string;
}

export function MCPJsonView({ code, maxHeight, className }: MCPJsonViewProps) {
  const tokens = useMemo(() => tokenizeJSON(code), [code]);
  return (
    <ScrollShadow
      className={cn("w-full rounded-md border border-border", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <Code
        className={cn(
          "block w-full bg-transparent px-3 py-2 text-left",
          "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
        )}
      >
        {tokens.map((token, index) => (
          <span key={index} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ))}
      </Code>
    </ScrollShadow>
  );
}
