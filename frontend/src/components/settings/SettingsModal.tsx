import * as React from "react";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SettingsSidebar } from "./SettingsSidebar";
import { UnsavedSettingsDialog } from "./UnsavedSettingsDialog";
import {
  clearDirtySettings,
  getDirtySettings,
  useDirtySettings,
} from "@/stores/settings-dirty-store";
import { GeneralSettings } from "./tabs/GeneralSettings";
import { AppearanceSettings } from "./tabs/AppearanceSettings";
import { DataControl } from "./tabs/DataControl";
import { FeedsSettings } from "./tabs/FeedsSettings";
import { FoldersSettings } from "./tabs/FoldersSettings";
import { AISettings } from "./tabs/AISettings";
import { AutomationSettings } from "./tabs/AutomationSettings";
import { NetworkSettings } from "./tabs/NetworkSettings";
import { AdvancedSettings } from "./tabs/AdvancedSettings";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDraggableDialog } from "@/hooks/useDraggableDialog";
import { GripVertical } from "lucide-react";
import { useFilterEditorStore } from "@/stores/filter-editor-store";

export type SettingsTab =
  | "general"
  | "network"
  | "appearance"
  | "ai"
  | "data"
  | "feeds"
  | "folders"
  | "automation"
  | "advanced";

/**
 * 设置标签的显示顺序 —— 按「用得多少」排，不是按模块新旧：
 *   外观（主题/字体/卡片，天天调）→ 订阅/文件夹（增删订阅）→ 通用（语言、阅读行为、RSSHub 实例）
 *   → AI（模型与自动摘要翻译）→ 自动化（过滤规则）→ 网络（代理）→ 高级（域名限流）→ 数据控制（导入导出/清缓存，低频且有破坏性）
 * 侧栏与移动端下拉共用这一份顺序。
 */
export const SETTINGS_TAB_ORDER: SettingsTab[] = [
  "appearance",
  "feeds",
  "folders",
  "general",
  "ai",
  "automation",
  "network",
  "advanced",
  "data",
];

/** 每个标签对应的文案键（侧栏与下拉共用） */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: "settings.general",
  network: "settings.network",
  appearance: "settings.appearance",
  ai: "settings.ai",
  data: "settings.data",
  feeds: "settings.subscriptions",
  folders: "settings.folders",
  automation: "automation.title",
  advanced: "settings.advanced",
};

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const isMobile = useIsMobile();
  /**
   * 从设置里打开的抽屉/弹层（目前是规则·视图编辑器）被 RootPortal 挂到 body 上，
   * 相对 Radix Dialog 是**兄弟节点**，于是 Radix 把「点抽屉里的东西」判成「点到了外面」，
   * 顺手把设置一起关掉 —— 用户要的是「抽屉关了，我还留在设置里」。
   * 所以只要子浮层开着，就不让设置因外部交互而关闭（点遮罩仍会关掉子浮层本身）。
   */
  const childOverlayOpen = useFilterEditorStore((state) => state.open);
  const guardOutsideDismiss = React.useCallback(
    (event: { preventDefault: () => void }) => {
      if (childOverlayOpen) event.preventDefault();
    },
    [childOverlayOpen],
  );
  /**
   * 同理还有 Esc：Radix 的 Escape 处理器只认自己的浮层栈，抽屉不在里面，
   * 于是按一次 Esc 会既关抽屉又关设置 —— 设置里打开的抽屉按 Esc 只该关抽屉。
   */
  const guardEscape = React.useCallback(
    (event: KeyboardEvent) => {
      if (childOverlayOpen) event.preventDefault();
    },
    [childOverlayOpen],
  );

  /**
   * 12-7：表单型设置页（AI / 网络 / 通知 / RSSHub / 通用里的 UA / 资料）改完是「点保存才写库」，
   * 所以切页或关设置之前要先问一句。即时型（开关/数量）的页不登记，不受影响。
   */
  const dirtyEntries = useDirtySettings();
  const [pendingLeave, setPendingLeave] = React.useState<(() => void) | null>(null);
  const [leaving, setLeaving] = React.useState(false);

  /**
   * 23-3：设置窗口可拖动（「边看边改」——拖开一点就能看到背后的界面）。
   * HeroUI v3 的 `Modal` 没有原生拖动（官方 API 表里只有 backdrop 变体 / 关闭行为 / 尺寸 / 位置），
   * 所以照组件库 `Drawer` 那套 pointer 手势自己搬一份，见 `useDraggableDialog`。
   * 只有桌面这版是窗口（移动端是全屏 Sheet，没有可拖的余地）。
   */
  const drag = useDraggableDialog();

  const tryLeave = React.useCallback((action: () => void) => {
    if (getDirtySettings().length > 0) {
      setPendingLeave(() => action);
      return;
    }
    action();
  }, []);

  const handleSaveAndLeave = React.useCallback(async () => {
    const entries = getDirtySettings();
    setLeaving(true);
    try {
      await Promise.all(entries.map((entry) => entry.save?.()));
    } finally {
      setLeaving(false);
      clearDirtySettings();
      const action = pendingLeave;
      setPendingLeave(null);
      action?.();
    }
  }, [pendingLeave]);

  const handleDiscard = React.useCallback(() => {
    clearDirtySettings();
    const action = pendingLeave;
    setPendingLeave(null);
    action?.();
  }, [pendingLeave]);

  const unsavedDialog = (
    <UnsavedSettingsDialog
      open={pendingLeave !== null}
      labels={dirtyEntries.map((entry) => entry.label)}
      canSave={dirtyEntries.some((entry) => !!entry.save)}
      busy={leaving}
      onSaveAndLeave={handleSaveAndLeave}
      onDiscard={handleDiscard}
      onStay={() => setPendingLeave(null)}
    />
  );

  // Reset to general when modal opens
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("general");
    }
  }, [open]);

  const renderContent = () => {
    switch (activeTab) {
      case "general":
        return <GeneralSettings />;
      case "network":
        return <NetworkSettings />;
      case "appearance":
        return <AppearanceSettings />;
      case "ai":
        return <AISettings />;
      case "automation":
        return <AutomationSettings />;
      case "data":
        return <DataControl />;
      case "feeds":
        return <FeedsSettings />;
      case "folders":
        return <FoldersSettings />;
      case "advanced":
        return <AdvancedSettings />;
      default:
        return null;
    }
  };

  const getTitle = () => {
    switch (activeTab) {
      case "general":
        return t("settings.general");
      case "network":
        return t("settings.network");
      case "appearance":
        return t("settings.appearance");
      case "ai":
        return t("settings.ai");
      case "automation":
        return t("automation.title");
      case "data":
        return t("settings.data");
      case "feeds":
        return t("settings.subscriptions");
      case "folders":
        return t("settings.folders");
      case "advanced":
        return t("settings.advanced");
      default:
        return t("settings.title");
    }
  };

  const tabs: { id: SettingsTab; label: string }[] = SETTINGS_TAB_ORDER.map(
    (id) => ({ id, label: t(SETTINGS_TAB_LABEL_KEYS[id]) }),
  );

  // Mobile layout
  if (isMobile) {
    return (
      <Dialog
      open={open}
      // C-①：子浮层（规则编辑器 HeroUI Drawer，portal 到 body）开着时切非 modal ——
      // Radix modal 的滚动锁只认自己 content，Drawer 在外面会被吃掉 wheel/touchmove；
      // 非 modal 时 Radix 不挂滚动锁，Drawer.Body 自由滚。Esc/外部点击仍由下面两道 guard 拦住，
      // 遮罩由 Drawer 自己的 Backdrop 补（桌面 620px 抽屉/移动全屏都有全屏 backdrop）。
      modal={!childOverlayOpen}
      onOpenChange={(next) => (next ? onOpenChange(true) : tryLeave(() => onOpenChange(false)))}
    >
        <DialogContent
          className="!inset-0 !translate-x-0 !translate-y-0 h-dvh w-full max-w-none max-h-none rounded-none bg-background p-0 overflow-hidden gap-0"
          onInteractOutside={guardOutsideDismiss}
          onEscapeKeyDown={guardEscape}
        >
          <div className="flex h-full min-h-0 flex-col bg-background safe-area-inset">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
              <Select
                ariaLabel={t("settings.title")}
                value={activeTab}
                onChange={(value) => tryLeave(() => setActiveTab(value as SettingsTab))}
                options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
                className="flex-1"
              />
              <button
                onClick={() => tryLeave(() => onOpenChange(false))}
                className={cn(
                  "rounded-[var(--radius)] p-1.5 shrink-0",
                  "text-muted-foreground hover:text-foreground hover:bg-secondary",
                  "transition-colors focus:outline-none",
                )}
                aria-label={t("entry.close")}
              >
                <svg
                  className="size-5"
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

            {/* Content */}
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
              {renderContent()}
            </div>
            {unsavedDialog}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Desktop layout
  return (
    <Dialog
      open={open}
      // C-①：同移动端分支（子浮层开着时切非 modal，把滚动锁让给 HeroUI Drawer）
      modal={!childOverlayOpen}
      onOpenChange={(next) => (next ? onOpenChange(true) : tryLeave(() => onOpenChange(false)))}
    >
      <DialogContent
        ref={drag.dialogRef}
        // 拖动位移叠在 Radix 的居中位移上（`-translate-x-1/2 -translate-y-1/2`）
        style={{ transform: drag.transform }}
        className="w-[950px] h-[800px] max-w-[95vw] max-h-[90vh] p-0 overflow-hidden gap-0"
        onInteractOutside={guardOutsideDismiss}
        onEscapeKeyDown={guardEscape}
      >
        <div className="flex h-full">
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={(tab) => tryLeave(() => setActiveTab(tab))}
          />

          <div className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
            {/* Header —— 23-3：整条标题栏就是拖动把手（`touch-none` 挡住触控板滚动/选择，
                交互元素在 hook 里被排除，所以点得到里面的任何控件） */}
            <div
              {...drag.handleProps}
              className="flex cursor-move touch-none select-none items-center gap-2 border-b border-border px-6 py-4"
            >
              <GripVertical className="size-4 shrink-0 text-muted-foreground/60" />
              <DialogTitle className="text-xl font-bold">
                {getTitle()}
              </DialogTitle>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto px-6 py-4">
              {renderContent()}
            </div>
            {unsavedDialog}

            {/* Close button */}
            <button
              onClick={() => tryLeave(() => onOpenChange(false))}
              className={cn(
                "absolute right-4 top-4 rounded-[var(--radius)] p-1.5",
                "text-muted-foreground hover:text-foreground hover:bg-secondary",
                "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={t("entry.close")}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
