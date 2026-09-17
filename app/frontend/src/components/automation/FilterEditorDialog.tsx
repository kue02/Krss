import { useTranslation } from "react-i18next";
import { Button, Drawer } from "@heroui/react";
import { FilterEditor } from "./FilterEditor";
import { useFilterMutations } from "@/hooks/useFilters";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { FilterWritePayload } from "@/types/filters";

/**
 * 规则编辑器外壳 —— 一套表单，两种壳（2026-09-17 用户拍板的「方案 A」）：
 *
 *   - 桌面：右侧抽屉（HeroUI `Drawer` placement="right"，620px）
 *   - 移动端：全屏 Sheet（placement="bottom" + 占满高度）
 *
 * 为什么两边不都用全屏：桌面从右键订阅「新建规则」长出一个整屏面板会打断阅读上下文，
 * 且 HeroUI 弹层的动效是「侧滑 / 上滑」，整屏居中面板的放大淡入与「从点击处长出来」的直觉不符。
 * 为什么移动端不沿用桌面抽屉：窄屏上抽屉会挤压内容，键盘弹出时布局抖动。
 * 两种壳共用同一个 `<FilterEditor>`，差别只在容器 —— 没有第二套表单要维护。
 *
 * 打开状态在 filter-editor-store 里，设置页 / 订阅右键 / 条目右键三个入口都能唤起它；
 * 这里只负责挂出来并接上保存。
 */
export function FilterEditorDialog() {
  const { t } = useTranslation();
  const { open, draft, editingId, kind, draftNotes, draftWarnings, close } =
    useFilterEditorStore();
  const { create, update } = useFilterMutations();
  const isMobile = useIsMobile();

  const saving = create.isPending || update.isPending;

  const title =
    kind === "view"
      ? editingId
        ? t("automation.edit_view")
        : t("automation.new_view")
      : editingId
        ? t("automation.edit")
        : t("automation.new_rule");

  const handleSubmit = (payload: FilterWritePayload) => {
    if (editingId) {
      update.mutate({ id: editingId, payload }, { onSuccess: () => close() });
      return;
    }
    create.mutate(payload, { onSuccess: () => close() });
  };

  return (
    <Drawer>
      <Button className="hidden" aria-hidden />
      <Drawer.Backdrop
        isOpen={open}
        onOpenChange={(next) => !next && close()}
        isDismissable
      >
        <Drawer.Content
          placement={isMobile ? "bottom" : "right"}
          className={
            isMobile
              ? // 移动端：底部上滑的全屏 Sheet
                "inset-x-0 bottom-0 top-auto h-dvh w-full max-w-none rounded-none"
              : // 桌面：右侧抽屉。**必须显式贴边**：HeroUI 的 content 默认 left/right 齐设（过约束），
                // 只给宽度会让浏览器按 left 解，抽屉会跑到左边去（实测 x=0）。
                "left-auto right-0 top-0 h-dvh w-[620px] max-w-[96vw] rounded-none"
          }
        >
          <Drawer.Dialog className="flex h-full min-h-0 flex-col p-0">
            <Drawer.Header className="shrink-0 border-b border-border px-5 py-3">
              <Drawer.Heading className="text-base font-semibold">
                {title}
              </Drawer.Heading>
            </Drawer.Header>

            <Drawer.Body className="min-h-0 flex-1 overflow-y-auto p-0">
              {draft && (
                <FilterEditor
                  key={`${editingId ?? "new"}:${kind}:${draft.scopeId ?? ""}`}
                  initial={draft}
                  kind={kind}
                  notes={draftNotes}
                  warnings={draftWarnings}
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
            </Drawer.Body>

            <Drawer.CloseTrigger />
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
