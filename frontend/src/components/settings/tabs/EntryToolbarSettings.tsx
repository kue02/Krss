import { useCallback, useMemo } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { Button } from "@heroui/react";
import { GripVertical, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  defaultEntryToolbar,
  normalizeEntryToolbar,
  type EntryToolbarItem,
  type EntryToolbarItemId,
  type EntryToolbarPlacement,
} from "@/lib/entry-toolbar";
import { useUISettingActions, useUISettingKey } from "@/hooks/useUISettings";

/**
 * REQ1：文章工具栏自定义（显隐 + 拖拽排序 + 放入「更多」）。
 *
 * - 顺序与去向都落在 `useUISettings().entryToolbar`（`{ id, placement }[]`），
 *   由 `normalizeEntryToolbar()` 做「未知 id 丢弃、缺失 id 补回、脏值回落」的兜底；
 * - 每一项三档去向：显示在工具栏 / 收进「更多」三点菜单 / 永久隐藏（连更多都不进），
 *   这样以后插件与新按钮变多时可以靠「更多」消化，不常用的永久隐藏；
 * - 拖拽用 framer-motion `Reorder`，手柄独立（`dragListener={false}` + `useDragControls`），
 *   避免按住分段控件时误触发排序；
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
  placementLabels,
  onPlacementChange,
}: {
  item: EntryToolbarItem;
  label: string;
  placementLabels: Record<EntryToolbarPlacement, string>;
  onPlacementChange: (id: EntryToolbarItemId, placement: EntryToolbarPlacement) => void;
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
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <SegmentedControl<EntryToolbarPlacement>
        value={item.placement}
        onValueChange={(placement) => onPlacementChange(item.id, placement)}
        className="shrink-0"
        options={[
          { value: "toolbar", label: placementLabels.toolbar },
          { value: "more", label: placementLabels.more },
          { value: "hidden", label: placementLabels.hidden },
        ]}
      />
    </Reorder.Item>
  );
}

export function EntryToolbarSettings() {
  const { t } = useTranslation();
  const stored = useUISettingKey("entryToolbar");
  const { setEntryToolbar } = useUISettingActions();
  const items = useMemo(() => normalizeEntryToolbar(stored), [stored]);

  const placementLabels = useMemo<Record<EntryToolbarPlacement, string>>(
    () => ({
      toolbar: t("appearance_reading.entry_toolbar_place_toolbar"),
      more: t("appearance_reading.entry_toolbar_place_more"),
      hidden: t("appearance_reading.entry_toolbar_place_hidden"),
    }),
    [t],
  );

  const handleReorder = useCallback(
    (next: EntryToolbarItem[]) => {
      setEntryToolbar(normalizeEntryToolbar(next));
    },
    [setEntryToolbar],
  );

  const handlePlacementChange = useCallback(
    (id: EntryToolbarItemId, placement: EntryToolbarPlacement) => {
      setEntryToolbar(
        items.map((item) =>
          item.id === id ? { ...item, placement } : item,
        ),
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
            placementLabels={placementLabels}
            onPlacementChange={handlePlacementChange}
          />
        ))}
      </Reorder.Group>
    </div>
  );
}
