import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PluginSlot, PluginActionDialog } from "./PluginSlot";
import { usePendingPluginActionStore } from "./pendingAction";
import type { PluginContribution, PluginSelection } from "./types";

/**
 * 56-10：`PluginSlot` —— 插件声明的界面贡献落到界面上。
 *
 * 两条形态（右键菜单项 / 工具栏按钮）共用一套「点了之后干什么」：
 * 有 `fields` 先弹表单、有 `confirm` 先弹确认、都没有直接调动作。
 *
 * 弹窗挂在 `PluginActionDialog`（App 顶层，与 FilterEditorDialog 同级）而不是插槽自己身上：
 * 右键菜单一点就关、菜单子树整个卸载（Radix `Presence`），挂在里面的弹窗会跟着消失 ——
 * 这条在测试里也是真的：菜单项点下去之后 `PluginSlot` 已经不在了，表单仍然要出来。
 * 所以测试渲染插槽时把宿主一起挂上，走的是线上同一套结构。
 */
const { mutateMock, contributions } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./useContributions", () => ({
  useContributions: () => contributions.current,
}));

// 只打桩「调用动作」这一层：断言的是插槽交出去的 selection / config
vi.mock("./useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: mutateMock, isPending: false }),
}));

afterEach(() => {
  cleanup();
  mutateMock.mockClear();
  usePendingPluginActionStore.getState().close();
  contributions.current = [];
});

function contribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "notify",
    surface: "entry.contextmenu",
    action: "notify",
    label: "推送到手机（Bark）",
    selection: "none",
    ...overrides,
  };
}

/** 插槽 + 弹窗宿主（线上也是分开挂的：宿主在 App 顶层） */
function renderSlot(
  variant: "menu" | "toolbar",
  selection: PluginSelection = { entryIds: [1] },
) {
  const slot = (
    <PluginSlot
      surface="entry.contextmenu"
      selection={selection}
      variant={variant}
    />
  );

  if (variant === "toolbar") {
    return render(
      <>
        {slot}
        <PluginActionDialog />
      </>,
    );
  }

  return render(
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <span>trigger</span>
        </ContextMenuTrigger>
        <ContextMenuContent>{slot}</ContextMenuContent>
      </ContextMenu>
      <PluginActionDialog />
    </>,
  );
}

/** 右键菜单形态：先把菜单打开，再点某一项 */
function openMenu() {
  fireEvent.contextMenu(screen.getByText("trigger"));
}

describe("PluginSlot", () => {
  it("① 这个挂点没有插件贡献 → 什么都不渲染（不占位）", () => {
    contributions.current = [];
    const { container } = renderSlot("toolbar", {});
    expect(container.innerHTML).toBe("");
  });

  it("② 两条贡献 → 两个菜单项，文案原样（不翻译）", () => {
    contributions.current = [
      contribution(),
      contribution({
        id: "export",
        action: "export",
        label: "导出为 Markdown",
        icon: "download",
      }),
    ];
    renderSlot("menu");
    openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("推送到手机（Bark）");
    expect(items[1]?.textContent).toContain("导出为 Markdown");
  });

  it("③ selection:\"single\" 但选中两条 → 该项不渲染（none 的不受影响）", () => {
    contributions.current = [
      contribution({ id: "single-only", label: "只处理单条", selection: "single" }),
      contribution({ id: "any", action: "any", label: "随时可用", selection: "none" }),
    ];
    renderSlot("menu", { entryIds: [1, 2] });
    openMenu();

    expect(screen.queryByText("只处理单条")).toBeNull();
    expect(screen.getByText("随时可用")).toBeTruthy();
  });

  it("④ 带 fields 的项 → 先弹表单；必填留空不提交，填好提交带上 config", () => {
    contributions.current = [
      contribution({
        id: "note",
        action: "note",
        label: "加一条备注",
        fields: [
          {
            key: "note",
            label: "备注内容",
            type: "text",
            required: true,
            placeholder: "写点什么",
          },
        ],
      }),
    ];
    renderSlot("menu", { entryIds: [7] });
    openMenu();
    fireEvent.click(screen.getByText("加一条备注"));

    // 菜单已关，表单仍然在（宿主在菜单之外）
    const input = screen.getByLabelText(/备注内容/) as HTMLInputElement;
    expect(input.value).toBe("");

    // 必填空着：不请求，只标红
    fireEvent.click(screen.getByText("actions.confirm"));
    expect(mutateMock).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "先看这段" } });
    fireEvent.click(screen.getByText("actions.confirm"));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]?.[0]).toEqual({
      selection: { entryIds: [7] },
      config: { note: "先看这段" },
    });
  });

  it("⑤ 带 confirm 的项 → 先确认；点取消不请求", () => {
    contributions.current = [
      contribution({
        id: "danger",
        action: "danger",
        label: "清空这条的缓存",
        confirm: "确定要清空吗？",
      }),
    ];
    renderSlot("toolbar", { entryIds: [3] });
    fireEvent.click(screen.getByText("清空这条的缓存"));

    expect(screen.getByText("确定要清空吗？")).toBeTruthy();
    fireEvent.click(screen.getByText("actions.cancel"));
    expect(mutateMock).not.toHaveBeenCalled();
    expect(screen.queryByText("确定要清空吗？")).toBeNull();
  });
});
