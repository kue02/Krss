import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@heroui/react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { PluginFieldControl } from "./fields";
import { PluginIcon } from "./icons";
import {
  openPendingPluginAction,
  usePendingPluginActionStore,
} from "./pendingAction";
import { useContributions } from "./useContributions";
import { useInvokePluginAction } from "./useInvokePluginAction";
import type { Surface } from "./surfaces";
import type { PluginContribution, PluginSelection } from "./types";

/**
 * 插件界面插槽（56-10）。
 *
 * 插件只声明「在哪个挂点、叫什么、点什么图标、点下去调哪个动作、要不要先填参数 /
 * 先确认」，长什么样由宿主决定 —— 这里就是那层决定：
 *   - `variant="menu"` → 右键菜单项（仓库既有的 `@/components/ui/context-menu`，
 *     HeroUI 没有右键菜单这一档，样式照 HeroUI `.menu-item` 量过，见该文件注释）
 *   - `variant="toolbar"` → HeroUI `Button size="sm"`（工具栏按钮）
 *
 * 过滤三条：`op="hide"`（藏宿主元素，56-16 才真正生效，这里先不渲染）、
 * `selection`（single 要求恰好选中 1 个对象、multi 至少 1 个、none 不看）、
 * 以及「没有贡献就不占位」。
 *
 * 弹窗（参数表单 / 确认）不在插槽里，在 `PluginActionDialog`：右键菜单一点就关、
 * 子树整个卸载，弹窗留在里面会跟着消失（详见 `pendingAction.ts`）。
 */
export function PluginSlot({
  surface,
  selection,
  variant,
  beforeInvoke,
}: {
  surface: Surface;
  selection: PluginSelection;
  variant: "menu" | "toolbar";
  /**
   * 点击后、真正调用动作**之前**要做完的事（56-14）。
   *
   * 用在「插件动作必须作用在一个已经落库的对象上」的挂点：规则编辑器底栏的新规则还没有 id，
   * 直接推就是一条没有规则的推送 —— 所以先保存，保存成功才继续。
   *
   * 约定：
   *   - 成功 → 继续（返回值可带一份 selection 补丁，例如刚拿到的 `filterId`，与传入的合并）
   *   - 抛错 → **什么都不做**（错误由调用方展示，这里不吞也不弹：插槽不知道文案）
   *   - 不传 → 行为与 56-10 完全一致（直接弹表单 / 直接调用）
   */
  beforeInvoke?: () => Promise<void | PluginSelection>;
}) {
  const contributions = useContributions(surface);
  const items = useMemo(
    () =>
      contributions.filter(
        /**
         * 只收「追加」项（没有 `op`）：`op:"hide"` / `op:"replace"` 是**改宿主已有控件**
         * （56-16，由 `useTargetOps` 在控件自己那儿处理），不是往挂点末尾再塞一个 ——
         * 两边都渲染的话，被顶掉的控件会以插件按钮的形式又出现一次。
         */
        (item) => !item.op && fitsSelection(item, selection),
      ),
    [contributions, selection],
  );

  if (items.length === 0) return null;

  return (
    <>
      {items.map((item) => (
        <PluginItem
          key={`${item.plugin}/${item.id}`}
          item={item}
          selection={selection}
          variant={variant}
          beforeInvoke={beforeInvoke}
        />
      ))}
    </>
  );
}

/**
 * 这条贡献要不要在当前选中态下出现。
 *
 * 「选了几个对象」只数条目与订阅（`entryIds + feedIds`）：`filterId` / `viewId` /
 * `textRange` 是「在哪个东西上」的定位信息，不是「选中了几条」，把它们算进去会让
 * 「只处理单条」的项在规则编辑器里永远不出现。
 */
function fitsSelection(
  item: PluginContribution,
  selection: PluginSelection,
): boolean {
  const count =
    (selection.entryIds?.length ?? 0) + (selection.feedIds?.length ?? 0);
  if (item.selection === "single") return count === 1;
  if (item.selection === "multi") return count >= 1;
  return true;
}

/**
 * 单条插件项的渲染（菜单项 / 工具栏按钮），56-16 起导出：
 * 「顶掉宿主控件」（`op:"replace"`）时要复用**同一份**渲染，不能为了替换再抄一遍
 * 点击链（前置动作 → 表单 → 确认 → 调用）。
 */
export function PluginItem({
  item,
  selection,
  variant,
  beforeInvoke,
}: {
  item: PluginContribution;
  selection: PluginSelection;
  variant: "menu" | "toolbar";
  beforeInvoke?: () => Promise<void | PluginSelection>;
}) {
  const invoke = useInvokePluginAction(item);
  /** 前置动作（保存）进行中：挡住重复点击，否则会保存两次 / 推两次 */
  const [preparing, setPreparing] = useState(false);

  /**
   * 点击顺序：先做前置动作（如果有）→ 要填参数就先弹表单 → 只要确认就先弹确认 → 都没有直接调。
   * 前两种交给顶层 `PluginActionDialog`（菜单项点完就卸载了，状态留不住）。
   *
   * 前置动作抛错 = 调用方明确表示「这次别调」，直接收工（错误由调用方展示）。
   */
  const run = async () => {
    let effective = selection;
    if (beforeInvoke) {
      setPreparing(true);
      try {
        const patch = await beforeInvoke();
        // 前置动作可以带回新拿到的上下文（例如刚保存出来的 filterId）
        if (patch) effective = { ...selection, ...patch };
      } catch {
        return;
      } finally {
        setPreparing(false);
      }
    }

    if (item.fields?.length || item.confirm) {
      openPendingPluginAction({ contribution: item, selection: effective });
      return;
    }
    invoke.mutate({ selection: effective });
  };

  const busy = preparing || invoke.isPending;

  const content = (
    <>
      <PluginIcon
        name={item.icon}
        className="size-4 shrink-0 text-muted-foreground"
      />
      {item.label}
    </>
  );

  if (variant === "menu") {
    return (
      <ContextMenuItem onSelect={run} disabled={busy}>
        {content}
      </ContextMenuItem>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onPress={run}
      isDisabled={busy}
      isPending={busy}
    >
      {content}
    </Button>
  );
}

/**
 * 插件动作的弹窗宿主（参数表单 / 确认），挂在 App 顶层，与 `FilterEditorDialog` 同级。
 *
 * 一次只服务一条待办动作（`pendingAction` store 里那一条）：先按 `fields` 画表单，
 * 没有字段就只显示 `confirm` 那句话。必填留空不提交、把该栏标红；提交成功才关窗
 * （失败留着值让用户改，错误由 `useInvokePluginAction` 统一弹 toast）。
 */
export function PluginActionDialog() {
  const pending = usePendingPluginActionStore((state) => state.pending);
  if (!pending) return null;
  // 换一条贡献就换一个实例：上一条填的值不会串到这一条
  return (
    <PluginActionDialogBody
      key={`${pending.contribution.plugin}/${pending.contribution.id}`}
      contribution={pending.contribution}
      selection={pending.selection}
    />
  );
}

function PluginActionDialogBody({
  contribution,
  selection,
}: {
  contribution: PluginContribution;
  selection: PluginSelection;
}) {
  const { t } = useTranslation();
  const close = usePendingPluginActionStore((state) => state.close);
  const invoke = useInvokePluginAction(contribution);
  const fields = useMemo(() => contribution.fields ?? [], [contribution]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [invalidKeys, setInvalidKeys] = useState<string[]>([]);

  const handleChange = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setInvalidKeys((prev) => prev.filter((item) => item !== key));
  };

  const submit = () => {
    const missing = fields
      .filter((field) => field.required && !(config[field.key] ?? "").trim())
      .map((field) => field.key);
    if (missing.length > 0) {
      setInvalidKeys(missing);
      return;
    }
    invoke.mutate(
      fields.length > 0 ? { selection, config } : { selection },
      { onSuccess: close },
    );
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(open) => !open && close()}>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{contribution.label}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {fields.length > 0 ? (
                <div className="space-y-2">
                  {fields.map((field) => (
                    <PluginFieldControl
                      key={field.key}
                      field={field}
                      value={config[field.key] ?? ""}
                      onChange={handleChange}
                      invalid={invalidKeys.includes(field.key)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {contribution.confirm}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button size="sm" variant="ghost" onPress={close}>
                {t("actions.cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onPress={submit}
                isDisabled={invoke.isPending}
                isPending={invoke.isPending}
              >
                {t("actions.confirm")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
