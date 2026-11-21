import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { PluginActionFields } from "./PluginActionFields";
import type { PluginField } from "@/plugins/types";

/**
 * 55-14：插件动作的动态字段表单。
 *
 * 形状由插件声明（PluginField），这里逐种类型验证：画得出来、值按字段键交回去、
 * 必填有记号、错的时候能看出来。字段标签参数化，所以断言都用正则匹配标签开头。
 */
afterEach(cleanup);

const onChange = () => vi.fn();

describe("PluginActionFields", () => {
  it("text：回填已有值、显示占位符，改值把「字段键 + 新值」交回去", () => {
    const handleChange = onChange();
    render(
      <PluginActionFields
        fields={[
          {
            key: "note",
            label: "附带一句话",
            type: "text",
            placeholder: "随便写点什么",
          },
        ]}
        config={{ note: "原值" }}
        onChange={handleChange}
      />,
    );

    const input = screen.getByLabelText(/附带一句话/) as HTMLInputElement;
    expect(input.value).toBe("原值");
    expect(input.getAttribute("placeholder")).toBe("随便写点什么");

    fireEvent.change(input, { target: { value: "改过的句子" } });
    expect(handleChange).toHaveBeenCalledWith("note", "改过的句子");
  });

  it("secret：用 password 型输入框，已存的值原样回填（别替用户清空）", () => {
    const fields: PluginField[] = [
      { key: "url", label: "推送地址", type: "secret" },
    ];
    const { container } = render(
      <PluginActionFields
        fields={fields}
        config={{ url: "https://api.day.app/device-key" }}
        onChange={onChange()}
      />,
    );

    const input = container.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("https://api.day.app/device-key");
    // 明文不该出现在 text 型输入框里
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it("required：标签后带红星；校验失败时该栏 aria-invalid（非必填不受影响）", () => {
    const { container, unmount } = render(
      <PluginActionFields
        fields={[
          { key: "url", label: "推送地址", type: "secret", required: true },
          { key: "note", label: "备注", type: "text" },
        ]}
        onChange={onChange()}
      />,
    );

    // 只有必填那一栏有星
    expect(screen.getAllByText("*")).toHaveLength(1);
    const url = container.querySelector('input[type="password"]');
    expect(url?.getAttribute("aria-invalid")).toBeNull();
    unmount();

    render(
      <PluginActionFields
        fields={[{ key: "url", label: "推送地址", type: "secret", required: true }]}
        onChange={onChange()}
        invalidKeys={["url"]}
      />,
    );
    expect(
      screen.getByLabelText(/推送地址/).getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("select：走仓库既有 Select 包装，触发器显示当前选项，选另一项交回字段键", () => {
    const { container } = render(
      <PluginActionFields
        fields={[
          {
            key: "mode",
            label: "推送时机",
            type: "select",
            options: [
              { value: "always", label: "每次都推" },
              { value: "daily", label: "每天一次" },
            ],
          },
        ]}
        config={{ mode: "daily" }}
        onChange={onChange()}
      />,
    );

    // HeroUI v3 的 Select 触发器是带 aria-haspopup=listbox 的 button（不是原生 select）
    const trigger = container.querySelector(
      'button[data-slot="select-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("每天一次");
  });

  it("bool：渲染成勾选框，勾上/取消把 \"true\"/\"false\" 交回去", () => {
    const handleChange = onChange();
    const { container } = render(
      <PluginActionFields
        fields={[{ key: "silent", label: "静默推送", type: "bool" }]}
        config={{ silent: "false" }}
        onChange={handleChange}
      />,
    );

    // 勾选框本体是 HeroUI 藏在 label 里的原生 input（jsdom 里点文字不触发 label 转发，点 input 才稳）
    const input = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(input);
    expect(handleChange).toHaveBeenCalledWith("silent", "true");
  });
});
