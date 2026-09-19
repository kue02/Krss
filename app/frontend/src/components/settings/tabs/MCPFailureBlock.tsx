import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  mcpFailureBucketLabelKey,
  mcpFailureExits,
  type MCPFailureExit,
} from "@/lib/mcp";
import type { MCPFailure } from "@/types/mcp";
import { copyToClipboard } from "@/stores/toast-store";

/**
 * 结构化失败展示（16-12 口径）：结论一句话（人话）+ 一句建议 + 可复制原始返回。
 * 列表行 / 测试按钮 / 向导预览**三处共用**这一个组件；桶决定出口按钮：
 * 认证桶 →「去配 Header / 改用 OAuth」；传输出错 →「切 SSE 重试 + 重新探测」。
 *
 * compact = 列表行里的收起态（一行标题 + 展开箭头）；展开后与完整态同内容。
 */
interface MCPFailureBlockProps {
  failure: MCPFailure;
  /** 出口按钮点到哪：父组件接（切传输要改草稿、OAuth 要切认证页，动作各不相同） */
  onExit?: (exit: MCPFailureExit) => void;
  compact?: boolean;
  className?: string;
}

const EXIT_LABEL_KEY: Record<MCPFailureExit, string> = {
  to_header: "ai_settings.mcp_exit_to_header",
  to_oauth: "ai_settings.mcp_exit_to_oauth",
  to_sse: "ai_settings.mcp_exit_to_sse",
  redetect: "ai_settings.mcp_exit_redetect",
  none: "",
};

export function MCPFailureBlock({
  failure,
  onExit,
  compact = false,
  className,
}: MCPFailureBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(!compact);
  const exits = mcpFailureExits(failure).filter((exit) => exit !== "none");

  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {compact && (
          <button
            type="button"
            aria-label={expanded ? t("actions.collapse") : t("actions.expand")}
            onClick={() => setExpanded((prev) => !prev)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        )}
        <span className="text-xs font-medium text-destructive">
          {failure.title}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t(mcpFailureBucketLabelKey(failure.bucket))}
        </span>
      </div>

      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {failure.suggestion && (
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.mcp_failure_suggestion")}: {failure.suggestion}
            </p>
          )}
          {exits.length > 0 && onExit && (
            <div className="flex flex-wrap gap-1.5">
              {exits.map((exit) => (
                <Button
                  key={exit}
                  size="sm"
                  variant={exit === "to_oauth" || exit === "to_sse" ? "primary" : "secondary"}
                  onPress={() => onExit(exit)}
                >
                  {t(EXIT_LABEL_KEY[exit])}
                </Button>
              ))}
            </div>
          )}
          {failure.raw && (
            <div className="flex items-start gap-1.5">
              <pre className="min-w-0 flex-1 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
                {failure.raw}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("actions.copy")}
                onPress={() =>
                  void copyToClipboard(
                    failure.raw ?? "",
                    t("ai_settings.mcp_raw_copied"),
                  )
                }
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
