import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginFieldControl } from "./fields";
import type { PluginField } from "./types";

/**
 * 56-9：一个 `PluginField` → 一个控件。
 *
 * 这段渲染原来只活在 `components/automation/PluginActionFields.tsx` 里（55-14），
 * 插槽（56-10）的表单也要同一份，所以抽到这里。抽出是**行为零变化**的重构：
 * 逐种类型验证一遍（输入框/勾选框/下拉），外加一条源码断言盯住「别再抄第二份」。
 * 老文件自己的 5 例（`PluginActionFields.test.tsx`）与规则编辑器 15 例不许改断言。
 */
afterEach(cleanup);

describe("PluginFieldControl", () => {
  it("text：回填已有值、显示占位符，改值把「字段键 + 新值」交回去", () => {
    const handleChange = vi.fn();
    render(
      <PluginFieldControl
        field={{
          key: "note",
          label: "附带一句话",
          type: "text",
          placeholder: "随便写点什么",
        }}
        value="原值"
        onChange={handleChange}
      />,
    );

    const input = screen.getByLabelText(/附带一句话/) as HTMLInputElement;
    expect(input.value).toBe("原值");
    expect(input.getAttribute("placeholder")).toBe("随便写点什么");

    fireEvent.change(input, { target: { value: "改过的句子" } });
    expect(handleChange).toHaveBeenCalledWith("note", "改过的句子");
  });

  it("secret：password 型输入框；required 带红星；invalid 时 aria-invalid", () => {
    const field: PluginField = {
      key: "url",
      label: "推送地址",
      type: "secret",
      required: true,
    };
    const { container, unmount } = render(
      <PluginFieldControl field={field} value="" onChange={vi.fn()} />,
    );

    const input = container.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(screen.getAllByText("*")).toHaveLength(1);
    expect(input?.getAttribute("aria-invalid")).toBeNull();
    unmount();

    render(
      <PluginFieldControl field={field} value="" onChange={vi.fn()} invalid />,
    );
    expect(
      screen.getByLabelText(/推送地址/).getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("bool：勾选框，勾上/取消把 \"true\"/\"false\" 交回去", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <PluginFieldControl
        field={{ key: "silent", label: "静默推送", type: "bool" }}
        value="false"
        onChange={handleChange}
      />,
    );

    // HeroUI 的勾选框本体是 label 里的原生 input（jsdom 里点 input 才稳）
    const input = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(input);
    expect(handleChange).toHaveBeenCalledWith("silent", "true");
  });

  it("select：走仓库既有 Select 包装，触发器显示当前选项", () => {
    const { container } = render(
      <PluginFieldControl
        field={{
          key: "mode",
          label: "推送时机",
          type: "select",
          options: [
            { value: "always", label: "每次都推" },
            { value: "daily", label: "每天一次" },
          ],
        }}
        value="daily"
        onChange={vi.fn()}
      />,
    );

    const trigger = container.querySelector(
      'button[data-slot="select-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("每天一次");
  });

  it("PluginActionFields 复用它，不自己再画一份（源码断言）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "..", "components", "automation", "PluginActionFields.tsx"),
      "utf-8",
    );

    // 引的是这里，且真的渲染它
    expect(source).toContain("@/plugins/fields");
    expect(source).toContain("<PluginFieldControl");
    // 控件本体与按类型分支不再留在老文件里
    expect(source).not.toContain("<Input");
    expect(source).not.toContain("<Checkbox");
    expect(source).not.toContain("field.type ===");
  });
});
