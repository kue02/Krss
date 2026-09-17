import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { FilterEditor } from "./FilterEditor";
import { useFilterMutations } from "@/hooks/useFilters";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { FilterWritePayload } from "@/types/filters";

/**
 * 规则编辑器外壳 —— 贴在右侧的抽屉。
 *
 * 打开状态放在 filter-editor-store 里，所以设置页、订阅右键、条目右键三个入口
 * 都能唤起同一个编辑器；这里只负责把它挂出来并接上保存。
 */
export function FilterEditorDialog() {
  const { t } = useTranslation();
  const { open, draft, editingId, close } = useFilterEditorStore();
  const { create, update } = useFilterMutations();

  const saving = create.isPending || update.isPending;

  const handleSubmit = (payload: FilterWritePayload) => {
    if (editingId) {
      update.mutate(
        { id: editingId, payload },
        { onSuccess: () => close() },
      );
      return;
    }
    create.mutate(payload, { onSuccess: () => close() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        className={
          "!inset-y-0 !left-auto !right-0 !top-0 !translate-x-0 !translate-y-0 " +
          "h-dvh w-[620px] max-w-[96vw] gap-0 rounded-none border-y-0 border-r-0 " +
          "border-l border-border bg-background p-0"
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
            <DialogTitle className="text-base font-semibold">
              {editingId ? t("automation.edit") : t("automation.new_rule")}
            </DialogTitle>
            <button
              type="button"
              onClick={close}
              aria-label={t("entry.close")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg
                className="size-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {draft && (
            <FilterEditor
              key={`${editingId ?? "new"}:${draft.scopeId ?? ""}`}
              initial={draft}
              saving={saving}
              saveError={
                create.isError || update.isError
                  ? t("automation.save_failed")
                  : null
              }
              onSubmit={handleSubmit}
              onCancel={close}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
