import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { FilterEditor } from "./FilterEditor";
import type { FilterWritePayload } from "@/types/filters";
import type { PluginContribution, PluginMeta } from "@/plugins/types";

const { previewMutate, fetchPluginsMock, invokeMutate, footerContributions } =
  vi.hoisted(() => ({
    previewMutate: vi.fn(),
    fetchPluginsMock: vi.fn(),
    invokeMutate: vi.fn(),
    /** 56-14：`filter.editor.footer` 这个挂点上的贡献（每个用例自己填） */
    footerContributions: { current: [] as PluginContribution[] },
  }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 55-14：规则编辑器挂载时会拉插件清单（停用不渲染 / 动态字段都靠它） */
vi.mock("@/plugins/api", () => ({ fetchPlugins: fetchPluginsMock }));

/**
 * 56-14：底栏插件插槽。只打桩「挂点上有哪些贡献」与「调用动作」两层，
 * 插槽（先保存再调用）走真实实现 —— 要验的正是那层顺序。
 */
vi.mock("@/plugins/useContributions", () => ({
  useContributions: (surface: string) =>
    footerContributions.current.filter((item) => item.surface === surface),
}));

vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: invokeMutate, isPending: false }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [{ id: "feed-1", title: "少数派" }] }),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => ({ data: [{ id: "folder-1", name: "技术" }] }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useFilterPreview: () => ({
    mutate: previewMutate,
    isPending: false,
    isError: false,
  }),
}));

afterEach(cleanup);
beforeEach(() => {
  previewMutate.mockClear();
  invokeMutate.mockReset();
  footerContributions.current = [];
  fetchPluginsMock.mockReset();
  // 默认「没有插件」：老用例不看插件动作区，别让它们被异步清单影响
  fetchPluginsMock.mockResolvedValue([]);
});

/** 一份插件清单样本：demo 的 log 动作（demo 内置、默认停用，这里按需改成启用） */
function demoPlugin(overrides: Partial<PluginMeta> = {}): PluginMeta {
  return {
    id: "demo",
    name: "Demo",
    description: "",
    version: "0.1.0",
    builtin: true,
    transport: "builtin",
    enabled: true,
    lastError: "",
    actions: [
      {
        pluginId: "demo",
        pluginName: "Demo",
        actionId: "log",
        label: "写一条调试日志（demo）",
        enabled: true,
        fields: [{ key: "note", label: "附带一句话（可选）", type: "text" }],
      },
    ],
    sections: [],
    ...overrides,
  };
}

/** 必填字段样本（Bark 形态：secret + required） */
function barkPlugin(): PluginMeta {
  return demoPlugin({
    id: "bark",
    name: "Bark 推送",
    actions: [
      {
        pluginId: "bark",
        pluginName: "Bark 推送",
        actionId: "notify",
        label: "推送到手机（Bark）",
        enabled: true,
        fields: [
          { key: "url", label: "推送地址", type: "secret", required: true },
        ],
      },
    ],
  });
}

/**
 * HeroUI 的 Checkbox：文字在 label 里、真正的 input 被视觉隐藏。
 * jsdom 不会把「点 label 里的文字」转发成 input 的 change，所以直接点 input。
 */
function clickCheckbox(labelText: string) {
  const root = screen.getByText(labelText).closest('[data-slot="checkbox"]');
  expect(root).not.toBeNull();
  fireEvent.click(root!.querySelector('input[type="checkbox"]') as HTMLElement);
}

function draft(overrides: Partial<FilterWritePayload> = {}): FilterWritePayload {
  return {
    name: "屏蔽推广",
    scopeType: "all",
    conditions: [{ field: "title", operator: "contains", value: "推广" }],
    actions: { mute: true },
    ...overrides,
  };
}

describe("FilterEditor", () => {
  it("11-9：把「有没有改过」上报给外壳（原始状态 false，改名后 true）", () => {
    const onPayloadChange = vi.fn();
    render(
      <FilterEditor
        initial={draft()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onPayloadChange={onPayloadChange}
      />,
    );

    const lastCall = () => onPayloadChange.mock.calls.at(-1) as [unknown, boolean];
    expect(lastCall()[1]).toBe(false);

    const nameInput = screen.getByDisplayValue("屏蔽推广") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "屏蔽推广 2" } });

    expect(lastCall()[1]).toBe(true);
  });

  it("名称为空时不提交，并给出校验提示", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ name: "  " })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });

  it("没有任何动作时不提交（后端也会拦）", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ actions: {} })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });

  it("条件值缺失时不提交（有值操作符必填）", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({
          conditions: [{ field: "title", operator: "contains", value: "" }],
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("三个互斥维度是 HeroUI 三态 radiogroup：选「静音」后「取消静音」落选，再选「不变」两边都清空", () => {
    const submit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ actions: { unmute: true } })}
        onSubmit={submit}
        onCancel={vi.fn()}
      />,
    );

    // HeroUI ToggleButtonGroup 渲染成 role=radiogroup，项是 role=radio，选中态走 data-selected
    const radio = (label: string) =>
      screen.getByText(label).closest('[role="radio"]') as HTMLElement;
    const mute = radio("automation.action_mute");
    const unmute = radio("automation.action_unmute");
    const none = screen.getAllByText("automation.action_none")[0] as HTMLElement;

    // 初始是反向（unmute）
    expect(unmute.getAttribute("data-selected")).toBe("true");
    expect(mute.getAttribute("data-selected")).toBeNull();

    // 选正向 → 反向落选
    fireEvent.click(mute);
    expect(mute.getAttribute("data-selected")).toBe("true");
    expect(unmute.getAttribute("data-selected")).toBeNull();

    // 选「不变」→ 两边都不带
    fireEvent.click(none);
    expect(mute.getAttribute("data-selected")).toBeNull();
    expect(unmute.getAttribute("data-selected")).toBeNull();
  });

  it("勾了「只保留匹配」后「静音」被禁用（否则等于全静音），并给出提示", () => {
    render(
      <FilterEditor
        initial={draft({ actions: { keepOnly: true } })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const mute = screen.getByText("automation.action_mute").closest("button") as HTMLButtonElement;
    expect(mute.disabled).toBe(true);
    // 反向仍然可用：「只保留匹配 + 取消静音」是合法的例外写法
    const unmute = screen
      .getByText("automation.action_unmute")
      .closest("button") as HTMLButtonElement;
    expect(unmute.disabled).toBe(false);
    // 并且告诉用户为什么点不动
    expect(screen.getByText("automation.mute_blocked_by_keep_only")).toBeTruthy();
  });

  it("可以添加条件行", () => {
    render(
      <FilterEditor
        initial={draft({ conditions: [] })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("automation.conditions_any")).toBeTruthy();
    fireEvent.click(screen.getByText("+ automation.add_condition"));
    expect(screen.queryByText("automation.conditions_any")).toBeNull();
    expect(document.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
  });

  /**
   * 用户 11-23：自动化规则里的条件默认从「且」改成「或」。
   * - 新建条件直接带 logic:"or"（payload 一定带 "or"，不靠展示兜底）
   * - 第二行起的连接词按钮显示「或」
   * - 点一下切回「且」
   */
  it("新建条件默认 logic=or、连接词显示「或」，点一下切回「且」", () => {
    const onPayloadChange = vi.fn();
    render(
      <FilterEditor
        initial={draft({ conditions: [] })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onPayloadChange={onPayloadChange}
      />,
    );
    const lastPayload = () =>
      onPayloadChange.mock.calls.at(-1)![0] as FilterWritePayload;

    // 加第一条：新建条件就带 logic:"or"（首条连接词不展示，但数据要带上）
    fireEvent.click(screen.getByText("+ automation.add_condition"));
    const afterFirst = lastPayload().conditions;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.logic).toBe("or");

    // 加第二条：连接词按钮默认显示「或」
    fireEvent.click(screen.getByText("+ automation.add_condition"));
    expect(lastPayload().conditions[1]?.logic).toBe("or");
    const toggle = screen.getByText("automation.logic_or");

    // 点一下切回「且」
    fireEvent.click(toggle);
    expect(lastPayload().conditions[1]?.logic).toBe("and");
    expect(screen.getByText("automation.logic_and")).toBeTruthy();
  });

  /**
   * 回归（用户第十一批 11-1「新建视图预览还是失败」）：
   * 预览曾经直接把 draft 发出去，而 draft 里没有 kind → 后端按「规则」校验，
   * 视图没有动作 → 400 invalid filter。预览与保存必须发同一份 payload。
   */
  it("视图预览的 payload 必须带 kind=view（否则后端按规则校验直接 400）", () => {
    render(
      <FilterEditor
        kind="view"
        initial={draft({ actions: {} })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).toHaveBeenCalledTimes(1);
    const [variables] = previewMutate.mock.calls[0] as [
      { payload: FilterWritePayload },
      { onSuccess: (result: unknown) => void },
    ];
    expect(variables.payload.kind).toBe("view");
    expect(variables.payload.actions).toEqual({});
  });

  it("规则的预览 payload 带 kind=rule，且动作原样送出", () => {
    render(
      <FilterEditor
        kind="rule"
        initial={draft()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    const [variables] = previewMutate.mock.calls[0] as [
      { payload: FilterWritePayload },
      { onSuccess: (result: unknown) => void },
    ];
    expect(variables.payload.kind).toBe("rule");
    expect(variables.payload.actions).toMatchObject({ mute: true });
  });

  it("点「预览影响」调用干跑接口，成功后展示命中摘要", async () => {
    render(
      <FilterEditor initial={draft()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).toHaveBeenCalledTimes(1);
    const [variables, options] = previewMutate.mock.calls[0] as [
      { payload: FilterWritePayload },
      { onSuccess: (result: unknown) => void },
    ];
    expect(variables.payload).toMatchObject({ name: "屏蔽推广" });

    // 模拟后端返回：命中 2 条、将静音 2 条（回调在 React 事件之外触发，要包 act）
    await act(async () => {
      options.onSuccess({
        scanned: 120,
        matchedCount: 2,
        muteCount: 2,
        markReadCount: 0,
        starCount: 0,
        matched: [
          {
            id: "1",
            title: "赞助商投稿",
            feedTitle: "Solidot",
            actions: { mute: true },
          },
        ],
      });
    });

    expect(screen.getByText("automation.preview_summary")).toBeTruthy();
    expect(screen.getByText("automation.preview_mute")).toBeTruthy();
    expect(screen.getByText("赞助商投稿")).toBeTruthy();
  });

  it("保存时提交去掉首尾空格的名称", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ name: "  屏蔽推广  " })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "屏蔽推广" }),
    );
  });

  /**
   * 55-14：插件动作区 —— 勾选后按插件声明的字段画表单，值写进
   * actions.pluginActions[].config，保存时原样带走（后端 filterActionsPayload 认这个键）。
   */
  it("勾选插件动作 → 出现它的字段；改值后保存 payload 带 pluginActions", async () => {
    fetchPluginsMock.mockResolvedValue([demoPlugin()]);
    const onSubmit = vi.fn();
    render(
      <FilterEditor initial={draft()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    // 清单是异步拉的：等动作复选框出现（同时证明「插件名」附在后面）
    await screen.findByText("写一条调试日志（demo）");
    expect(screen.getByText("automation.plugin_actions")).toBeTruthy();
    clickCheckbox("写一条调试日志（demo）");

    const noteInput = (await screen.findByLabelText(
      /附带一句话/,
    )) as HTMLInputElement;
    fireEvent.change(noteInput, { target: { value: "来自规则的一句话" } });

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: expect.objectContaining({
          pluginActions: [
            {
              plugin: "demo",
              action: "log",
              config: { note: "来自规则的一句话" },
            },
          ],
        }),
      }),
    );
  });

  /**
   * 真机回归：编辑器在抽屉关掉后并不卸载，重新打开如果没有重拉清单，
   * 刚停用的插件还会在动作区里（只有刷新页面才消失）。
   */
  it("重新打开编辑器（换了一份草稿）会重拉插件清单", async () => {
    fetchPluginsMock.mockResolvedValue([demoPlugin()]);
    const props = {
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(
      <FilterEditor initial={draft()} {...props} />,
    );
    await screen.findByText("写一条调试日志（demo）");
    expect(fetchPluginsMock).toHaveBeenCalledTimes(1);

    // 关掉再打开 = 外壳递进来一份新的 initial
    rerender(<FilterEditor initial={draft({ name: "另一条规则" })} {...props} />);
    expect(fetchPluginsMock).toHaveBeenCalledTimes(2);
  });

  /** 停用的插件不进编辑器 —— 这是插件契约（停用即不存在），不是界面上临时藏一下 */
  it("插件停用时它的动作复选框不渲染", async () => {
    fetchPluginsMock.mockResolvedValue([demoPlugin({ enabled: false })]);
    render(
      <FilterEditor initial={draft()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );

    // 等清单那一次微任务跑完，再断言「确实没有」
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginsMock).toHaveBeenCalled();
    expect(screen.queryByText("写一条调试日志（demo）")).toBeNull();
    // 一个可用动作都没有时，整块「插件动作」不出现（不留空标题）
    expect(screen.queryByText("automation.plugin_actions")).toBeNull();
  });

  /**
   * 必填校验：插件声明了 required 的字段空着 → 拦下保存并指名道姓；
   * 填好后**只挂插件动作**也能保存（hasAnyAction 认 pluginActions，否则等于「没有动作」）。
   */
  it("插件动作的必填字段空着时拦下保存，填好后只靠插件动作也能存", async () => {
    fetchPluginsMock.mockResolvedValue([barkPlugin()]);
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ actions: {} })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText("推送到手机（Bark）");
    clickCheckbox("推送到手机（Bark）");
    const urlInput = (await screen.findByLabelText(
      /推送地址/,
    )) as HTMLInputElement;

    fireEvent.click(screen.getByText("automation.save"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("automation.plugin_action_field_required"),
    ).toBeTruthy();
    // 空着的必填栏自己标红（不必让用户猜是哪一栏）
    expect(urlInput.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(urlInput, {
      target: { value: "https://api.day.app/rule-key" },
    });
    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: expect.objectContaining({
          pluginActions: [
            {
              plugin: "bark",
              action: "notify",
              config: { url: "https://api.day.app/rule-key" },
            },
          ],
        }),
      }),
    );
  });
});

/**
 * 56-14：规则编辑器底栏的「保存并推送」。
 *
 * 插件动作只能推**已经落库**的规则：新建规则时草稿还没有 id，直接 invoke 就会推一条
 * 没有规则的推送。所以点插件按钮必须先保存（拿到新 id），保存成功才继续；
 * 已有 id 的规则不重复保存。保存失败则什么都不做（错误由表单自己显示）。
 */
describe("FilterEditor × 插件底栏（56-14）", () => {
  function footerContribution(): PluginContribution {
    return {
      plugin: "bark",
      pluginName: "Bark 推送",
      id: "push",
      surface: "filter.editor.footer",
      action: "notify",
      label: "保存并推送（测试）",
      selection: "none",
    };
  }

  it("① 新建规则（还没有 id）→ 先保存，拿到新 id 后才 invoke", async () => {
    const order: string[] = [];
    const onSubmit = vi.fn(async () => {
      order.push("save");
      return "42";
    });
    invokeMutate.mockImplementation(() => {
      order.push("invoke");
    });
    footerContributions.current = [footerContribution()];

    render(
      <FilterEditor initial={draft()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("保存并推送（测试）"));

    await waitFor(() => expect(invokeMutate).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["save", "invoke"]);
    // 推的是刚落库的这条规则，而不是「没有规则的推送」
    expect(invokeMutate.mock.calls[0]?.[0]).toEqual({
      selection: { filterId: "42" },
    });
  });

  it("② 已有规则（有 id）→ 不重复保存，直接 invoke", async () => {
    const onSubmit = vi.fn();
    footerContributions.current = [footerContribution()];

    render(
      <FilterEditor
        filterId="7"
        initial={draft()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("保存并推送（测试）"));

    await waitFor(() => expect(invokeMutate).toHaveBeenCalledTimes(1));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(invokeMutate.mock.calls[0]?.[0]).toEqual({
      selection: { filterId: "7" },
    });
  });

  it("③ 保存失败 → 不 invoke，也不抛未捕获异常", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("保存失败");
    });
    footerContributions.current = [footerContribution()];

    render(
      <FilterEditor initial={draft()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("保存并推送（测试）"));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(invokeMutate).not.toHaveBeenCalled();
  });
});
