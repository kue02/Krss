import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Modal } from "@heroui/react";
import { ApiError, getFilterImpact, revertFilter } from "@/api";
import type { FilterImpactItem, FilterRule } from "@/types/filters";
import { MarqueeText } from "@/components/ui/marquee-text";
import { queryClient } from "@/lib/queryClient";
import { showToast } from "@/stores/toast-store";

/**
 * 撤销影响（用户 11-23 的原话）：撤销前先给出会被影响的条目清单，
 * 可以勾选其中一条或多条，只撤销勾选的；顺带给「星标要不要一起撤」（11-3 的待拍项）
 * 一个显式开关 —— 默认不撤：星标是用户自己的标记，不该被撤销规则顺手带走。
 */
export function RevertFilterDialog({
  rule,
  onClose,
}: {
  rule: FilterRule | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<FilterImpactItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeStarred, setIncludeStarred] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rule) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    setIncludeStarred(false);
    void getFilterImpact(rule.id)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        // 默认全选：绝大多数场景就是「全都撤掉」，只撤个别才需要动手
        setSelected(new Set(result.items.map((item) => item.entryId)));
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rule]);

  const allSelected = useMemo(
    () => items !== null && items.length > 0 && selected.size === items.length,
    [items, selected],
  );

  const toggleAll = useCallback(() => {
    if (!items) return;
    setSelected(
      allSelected ? new Set() : new Set(items.map((item) => item.entryId)),
    );
  }, [allSelected, items]);

  const toggleOne = useCallback((entryId: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(entryId);
      else copy.delete(entryId);
      return copy;
    });
  }, []);

  const handleRevert = useCallback(async () => {
    if (!rule) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await revertFilter(rule.id, {
        entryIds: [...selected],
        includeStarred,
      });
      queryClient.invalidateQueries({ queryKey: ["filters"] });
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      showToast(
        result.reverted > 0
          ? t("automation.revert_done", { count: result.reverted })
          : t("automation.revert_none"),
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [includeStarred, onClose, rule, selected, t]);

  const withStar = useMemo(
    () => (items ?? []).filter((item) => item.actions.star).length,
    [items],
  );

  return (
    <Modal>
      <Modal.Backdrop
        isOpen={rule !== null}
        onOpenChange={(open) => !open && onClose()}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-lg">
            <Modal.CloseTrigger />
            <div className="text-sm font-medium">
              {t("automation.revert_impact_title", { name: rule?.name ?? "" })}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("automation.revert_impact_description")}
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={toggleAll}
                className="rounded-full border border-border px-3 py-1 text-xs transition-colors duration-200 hover:bg-item-hover"
                disabled={!items || items.length === 0}
              >
                {allSelected
                  ? t("automation.revert_select_none")
                  : t("automation.revert_select_all")}
              </button>
              <div className="text-xs text-muted-foreground">
                {t("automation.revert_selected_count", {
                  selected: selected.size,
                  total: items?.length ?? 0,
                })}
              </div>
            </div>

            <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border p-2">
              {items === null && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {t("common.loading")}
                </div>
              )}
              {items !== null && items.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {t("automation.revert_impact_empty")}
                </div>
              )}
              {/* 13-2（效果图 revert-impact.html）：一条内容就一行 ——
                  勾选框固定 16px 在左、垂直居中；整行可点；标题占弹性宽度（超长才滚，短标题不裁）；
                  来源 + 状态是 shrink-0 的右尾，永远贴右缘，不再把标题挤成 91px（那会让跑马灯量不出距离）。
                  行高统一 38px。
                  **flex-row 是必须的**：HeroUI 的 `.checkbox` 在组件层写死 `flex-direction: column`
                  （勾选框一行、内容一行），不顶掉它就会把一条内容切成上下两块 ——
                  上一版只写 `flex` 没顶方向，真机量到「勾选框 y=416、标题 y=440、右尾 y=468」，
                  标题仍被挤到 95px、跑马灯等于没生效。utility 层压组件层（见 index.css 的分层），
                  但前提是这个类真的出现在源码里（Tailwind 是 JIT，运行时加类不生成）。 */}
              {(items ?? []).map((item) => (
                <Checkbox
                  key={item.entryId}
                  isSelected={selected.has(item.entryId)}
                  onChange={(isSelected) => toggleOne(item.entryId, isSelected)}
                  className="flex h-[38px] w-full flex-row cursor-pointer items-center gap-2 rounded px-2 hover:bg-secondary/40"
                >
                  <Checkbox.Control className="shrink-0">
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Checkbox.Content className="min-w-0 flex-1">
                    <MarqueeText
                      className="text-sm"
                      text={item.title || item.entryId}
                    />
                  </Checkbox.Content>
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {item.feedTitle}
                    {item.muted ? ` · ${t("automation.revert_flag_muted")}` : ""}
                    {item.starred ? ` · ${t("automation.revert_flag_starred")}` : ""}
                    {item.read ? "" : ` · ${t("automation.revert_flag_unread")}`}
                  </span>
                </Checkbox>
              ))}

              {/* 星标那一档跟条目列表同一块、用一条细线分组（效果图 ② 的排布），行高 32px */}
              {(items ?? []).length > 0 && (
                <>
                  <div className="my-2 h-px bg-border" />
                  <Checkbox
                    isSelected={includeStarred}
                    onChange={(isSelected) => setIncludeStarred(isSelected)}
                    isDisabled={withStar === 0}
                    className="flex h-8 w-full flex-row cursor-pointer items-center gap-2 rounded px-2 hover:bg-secondary/40"
                  >
                    <Checkbox.Control className="shrink-0">
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Content className="min-w-0 flex-1 text-xs font-normal text-muted-foreground">
                      {t("automation.revert_include_starred", { count: withStar })}
                    </Checkbox.Content>
                  </Checkbox>
                </>
              )}
            </div>

            {error && <div className="mt-3 text-xs text-destructive">{error}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={onClose}>
                {t("automation.cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onPress={handleRevert}
                isDisabled={isSaving || selected.size === 0}
              >
                {isSaving
                  ? t("automation.revert_running")
                  : t("automation.revert_selected_action", { count: selected.size })}
              </Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
