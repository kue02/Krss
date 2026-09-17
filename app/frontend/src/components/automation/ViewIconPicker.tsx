import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Popover, Tabs } from "@heroui/react";
import { ImagePlus, Smile, Sparkles } from "lucide-react";
import { downscaleImage } from "@/lib/downscale-image";
import { PARSE_HINT, VIEW_EMOJIS, VIEW_ICONS, BUILTIN_VIEW_ICONS, parseViewIcon } from "@/lib/view-icon";
import { cn } from "@/lib/utils";

/**
 * 视图图标选择器（用户 11-5）—— HeroUI `Popover` + `Tabs`，三段：内置图标 / Emoji / 上传。
 *
 * 上传复用头像那套 128px 缩放（`lib/downscale-image.ts`），存成 data URL；
 * 三种格式与后端 `normalizeViewIcon` 的白名单一一对应，认不出的前缀后端会清掉。
 */
export function ViewIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState("builtin");
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = parseViewIcon(value);

  const preview =
    parsed.kind === "image" ? (
      <img src={parsed.value} alt="" className="size-4 rounded-[3px] object-cover" />
    ) : parsed.kind === "emoji" ? (
      <span className="text-sm leading-none">{parsed.value}</span>
    ) : parsed.kind === "builtin" ? (
      (() => {
        const Icon = BUILTIN_VIEW_ICONS[parsed.value];
        return Icon ? <Icon className="size-4" /> : null;
      })()
    ) : null;

  return (
    <Popover.Root>
      <Popover.Trigger>
        <Button size="sm" variant="ghost" className="shrink-0 gap-1.5">
          {preview ?? <Sparkles className="size-4" />}
          {t("automation.view_icon")}
        </Button>
      </Popover.Trigger>
      <Popover.Content>
        <Popover.Dialog className="w-72 p-3">
          <Tabs.Root selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
            <Tabs.List className="mb-2">
              <Tabs.Tab id="builtin">{t("automation.view_icon_builtin")}</Tabs.Tab>
              <Tabs.Tab id="emoji">{t("automation.view_icon_emoji")}</Tabs.Tab>
              <Tabs.Tab id="upload">{t("automation.view_icon_upload")}</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel id="builtin">
              <div className="grid grid-cols-6 gap-1">
                {VIEW_ICONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    title={label}
                    aria-label={label}
                    data-icon-key={key}
                    onClick={() => onChange(`builtin:${key}`)}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md hover:bg-secondary",
                      parsed.kind === "builtin" && parsed.value === key && "bg-secondary",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
              </div>
            </Tabs.Panel>

            <Tabs.Panel id="emoji">
              <div className="grid grid-cols-8 gap-1">
                {VIEW_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => onChange(`emoji:${emoji}`)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base hover:bg-secondary",
                      parsed.kind === "emoji" && parsed.value === emoji && "bg-secondary",
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Smile className="size-4 text-muted-foreground" />
                <input
                  className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                  placeholder={t("automation.view_icon_emoji_input")}
                  aria-label={t("automation.view_icon_emoji_input")}
                  onChange={(event) => {
                    const text = event.target.value.trim().slice(0, 4);
                    if (text) onChange(`emoji:${text}`);
                  }}
                />
              </div>
            </Tabs.Panel>

            <Tabs.Panel id="upload">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    onChange(`data:${await downscaleImage(file, 128)}`.replace("data:data:", "data:"));
                  } catch {
                    // 读图失败就当没选（用户能看到预览没变）
                  }
                  event.target.value = "";
                }}
              />
              <Button size="sm" variant="ghost" onPress={() => fileRef.current?.click()}>
                <ImagePlus className="size-4" />
                {t("automation.view_icon_pick_file")}
              </Button>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("automation.view_icon_hint")}
              </div>
            </Tabs.Panel>
          </Tabs.Root>

          <div className="mt-3 flex justify-between border-t border-border/60 pt-2">
            <Button size="sm" variant="ghost" onPress={() => onChange("")}>
              {t("automation.view_icon_clear")}
            </Button>
            <span className="self-center text-[0.7rem] text-muted-foreground">
              {PARSE_HINT}
            </span>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover.Root>
  );
}
