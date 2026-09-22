import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog, Button, Drawer } from "@heroui/react";
import { FilterEditor } from "./FilterEditor";
import { useFilterMutations } from "@/hooks/useFilters";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import { showToast } from "@/stores/toast-store";
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
  /**
   * 用户 11-9 拍的口径：保存成功只提示「已保存」（不拦）；**有未保存改动时离开**才弹确认。
   * 表单把「当前 payload + 是否改过」上报上来（规范化规则在表单里），这里只负责拦一下。
   */
  const latestPayload = useRef<FilterWritePayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const title =
    kind === "view"
      ? editingId
        ? t("automation.edit_view")
        : t("automation.new_view")
      : editingId
        ? t("automation.edit")
        : t("automation.new_rule");

  const handleSubmit = (payload: FilterWritePayload) => {
    const onSuccess = () => {
      showToast(
        editingId ? t("automation.saved") : t("automation.created_saved"),
      );
      close();
    };
    if (editingId) {
      update.mutate({ id: editingId, payload }, { onSuccess });
      return;
    }
    create.mutate(payload, { onSuccess });
  };

  /** 所有关闭路径（取消按钮 / Esc / 点遮罩 / 右上关闭）都先过这里 */
  const requestClose = () => {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    close();
  };

  return (
    <Drawer>
      <Button className="hidden" aria-hidden />
      <Drawer.Backdrop
        isOpen={open}
        onOpenChange={(next) => !next && requestClose()}
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
                  onCancel={requestClose}
                  onPayloadChange={(payload, nextDirty) => {
                    latestPayload.current = payload;
                    setDirty(nextDirty);
                  }}
                />
              )}
            </Drawer.Body>

            <Drawer.CloseTrigger />
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      {/* 有未保存改动时离开 → 三选一（保存并关闭 / 放弃更改 / 继续编辑） */}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={confirmLeave}
          onOpenChange={(open) => !open && setConfirmLeave(false)}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-md">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {t("automation.unsaved_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {t("automation.unsaved_description")}
                </div>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setConfirmLeave(false)}
                >
                  {t("automation.unsaved_keep_editing")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setConfirmLeave(false);
                    setDirty(false);
                    close();
                  }}
                >
                  {t("automation.unsaved_discard")}
                </Button>
                <Button
                  size="sm"
                  onPress={() => {
                    setConfirmLeave(false);
                    setDirty(false);
                    const payload = latestPayload.current;
                    if (payload) handleSubmit(payload);
                  }}
                >
                  {t("automation.unsaved_save")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </Drawer>
  );
}
