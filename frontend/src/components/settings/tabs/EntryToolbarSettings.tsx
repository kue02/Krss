import { useCallback, useMemo } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { Button } from "@heroui/react";
import { GripVertical, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HeroSwitch } from "@/components/ui/hero-switch";
import {
  defaultEntryToolbar,
  normalizeEntryToolbar,
  type EntryToolbarItem,
  type EntryToolbarItemId,
} from "@/lib/entry-toolbar";
import { useUISettingActions, useUISettingKey } from "@/hooks/useUISettings";

/**
 * REQ1：文章工具栏自定义（显隐 + 拖拽排序）。
 *
 * - 顺序与显隐都落在 `useUISettings().entryToolbar`（`{ id, hidden }[]`），
 *   由 API 里的 `normalizeEntryToolbar()` 做「未知 id 丢弃、缺失 id 补回」的兜底；
 * - 拖拽用 framer-motion `Reorder`，与 `AppearanceSettings` 里分类排序同一套做法；
 * - 拖拽手柄独立（`dragListener={false}` + `useDragControls`），避免按住开关时误触发排序；
 * - 每个 item 的文案走 i18n，恢复默认直接写回 `defaultEntryToolbar()`。
 */
const ITEM_LABEL_KEYS: Record<EntryToolbarItemId, string> = {
  star: "appearance_reading.entry_toolbar_item_star",
  read: "appearance_reading.entry_toolbar_item_read",
  summary: "appearance_reading.entry_toolbar_item_summary",
  translate: "appearance_reading.entry_toolbar_item_translate",
  originalsite: "appearance_reading.entry_toolbar_item_originalsite",
  readable: "appearance_reading.entry_toolbar_item_readable",
  openexternal: "appearance_reading.entry_toolbar_item_openexternal",
};

function ToolbarRow({
  item,
  label,
  onToggle,
}: {
  item: EntryToolbarItem;
  label: string;
  onToggle: (id: EntryToolbarItemId, hidden: boolean) => void;
}) {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={dragControls}
      drag="y"
      dragElastic={0}
      dragTransition={{ bounceStiffness: 600, bounceDamping: 50 }}
      transition={{ duration: 0.15 }}
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5"
    >
      <button
        type="button"
        aria-label={label}
        className="cursor-grab touch-none text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
        onPointerDown={(event) => dragControls.start(event)}
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>
      <span className="flex-1 text-sm">{label}</span>
      <HeroSwitch
        isSelected={!item.hidden}
        onChange={(selected) => onToggle(item.id, !selected)}
        aria-label={label}
      />
    </Reorder.Item>
  );
}

export function EntryToolbarSettings() {
  const { t } = useTranslation();
  const stored = useUISettingKey("entryToolbar");
  const { setEntryToolbar } = useUISettingActions();
  const items = useMemo(() => normalizeEntryToolbar(stored), [stored]);

  const handleReorder = useCallback(
    (next: EntryToolbarItem[]) => {
      setEntryToolbar(normalizeEntryToolbar(next));
    },
    [setEntryToolbar],
  );

  const handleToggle = useCallback(
    (id: EntryToolbarItemId, hidden: boolean) => {
      setEntryToolbar(
        items.map((item) => (item.id === id ? { ...item, hidden } : item)),
      );
    },
    [items, setEntryToolbar],
  );

  const handleReset = useCallback(() => {
    setEntryToolbar(defaultEntryToolbar());
  }, [setEntryToolbar]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 gap-1.5 rounded-full border border-border"
          onPress={handleReset}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t("appearance_reading.entry_toolbar_reset")}
        </Button>
      </div>
      <Reorder.Group
        axis="y"
        values={items}
        onReorder={handleReorder}
        className="space-y-1.5"
      >
        {items.map((item) => (
          <ToolbarRow
            key={item.id}
            item={item}
            label={t(ITEM_LABEL_KEYS[item.id])}
            onToggle={handleToggle}
          />
        ))}
      </Reorder.Group>
    </div>
  );
}
