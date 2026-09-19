import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, TextArea } from "@heroui/react";
import { cn } from "@/lib/utils";
import { formatMCPJSON, minifyMCPJSON } from "@/lib/mcp";

/**
 * JSON 编辑区（16-13 口径）：HeroUI 没有代码编辑器（`Code` 只是行内 code），
 * 所以编辑用等宽 `TextArea` + 工具条「格式化 / 压缩 / 校验」（ghost 小按钮），
 * 校验失败给位置。不做「边打字边高亮」。
 */
interface MCPJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  rows?: number;
  className?: string;
}

export function MCPJsonEditor({
  value,
  onChange,
  ariaLabel,
  rows = 5,
  className,
}: MCPJsonEditorProps) {
  const { t } = useTranslation();
  const [validateError, setValidateError] = useState<string | null>(null);

  const handleFormat = useCallback(() => {
    const result = formatMCPJSON(value);
    if (result.ok) {
      setValidateError(null);
      onChange(result.text);
    } else {
      setValidateError(result.message);
    }
  }, [value, onChange]);

  const handleMinify = useCallback(() => {
    const result = minifyMCPJSON(value);
    if (result.ok) {
      setValidateError(null);
      onChange(result.text);
    } else {
      setValidateError(result.message);
    }
  }, [value, onChange]);

  const handleValidate = useCallback(() => {
    const result = formatMCPJSON(value);
    setValidateError(result.ok ? null : result.message);
  }, [value]);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onPress={handleFormat}>
          {t("ai_settings.mcp_json_format")}
        </Button>
        <Button size="sm" variant="ghost" onPress={handleMinify}>
          {t("ai_settings.mcp_json_minify")}
        </Button>
        <Button size="sm" variant="ghost" onPress={handleValidate}>
          {t("ai_settings.mcp_json_validate")}
        </Button>
      </div>
      <TextArea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => {
          setValidateError(null);
          onChange(event.target.value);
        }}
        rows={rows}
        className="w-full font-mono text-xs"
      />
      {validateError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {validateError}
        </p>
      )}
    </div>
  );
}
