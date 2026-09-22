import { useState } from "react";
import {
  Badge,
  Button,
  Chip,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Popover,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { RotateCcw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HeroSwitch } from "@/components/ui/hero-switch";
import { UnreadIndicator } from "@/components/entry-list/unread-indicator";
import {
  DEFAULT_UNREAD_BADGE,
  MAX_UNREAD_BADGE_OFFSET,
  useUISettingActions,
  useUISettingKey,
  type UnreadBadgeConfig,
} from "@/hooks/useUISettings";
import { cn } from "@/lib/utils";

/**
 * 13-3：未读角标的自定义面板（效果图 `unread-badge-config.html`）。
 *
 * 铁律（用户本项目一贯要求）：**每一项都落在 HeroUI `Badge` 的官方 prop 上**，不自己造风格 ——
 * 位置 = `placement`、大小 = 尺寸、颜色 = `color` 或自定义色、外观 = `variant`、内容 = 子节点。
 * 面板本身用 HeroUI `Popover`（不新开抽屉/弹窗），排版照 13-1 定下的 `标签列 92px + 控件列 1fr`。
 *
 * 三项按效果图与实测修正过的地方（2026-09-18 重做）：
 * 1. **位置是四个大格子**（22px 预览图标 + 左上/右上/左下/右下），不是四个箭头字 —— 效果图就是这么画的；
 *    格子里的预览直接摆 HeroUI `Badge`（真组件、真 `placement`），不是手画的圆点。
 * 2. **滑杆要挂 `Slider.Track` / `Slider.Thumb`**：HeroUI v3 的 `Slider` 只写 props 的话
 *    只渲染出一条 4px 的空轨道（真机量到 `h=4`、没有滑块），根本拖不动。开关同理走 `HeroSwitch`。
 * 3. **实时预览用真组件 `UnreadIndicator`**：与列表里同一份渲染逻辑，改哪一项立刻反映出来。
 *
 * 用户 2026-09-18 的裁定：圆点是**默认档**、且是**单独不变的样式** —— 选「圆点」时
 * 位置/大小/颜色/外观四项置灰并给出提示（它们只作用于未读数/图标两档）。
 */
const PLACEMENTS: UnreadBadgeConfig["placement"][] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** 位置档位的 i18n 键后缀 */
const PLACEMENT_KEYS: Record<UnreadBadgeConfig["placement"], string> = {
  "top-left": "unread_badge_placement_top_left",
  "top-right": "unread_badge_placement_top_right",
  "bottom-left": "unread_badge_placement_bottom_left",
  "bottom-right": "unread_badge_placement_bottom_right",
};

/** 大小预设：效果图的「小 6 / 中 8 / 大 10」（滑杆是同一处的细调） */
const SIZE_PRESETS: { size: number; key: string }[] = [
  { size: 6, key: "unread_badge_size_small" },
  { size: 8, key: "unread_badge_size_medium" },
  { size: 10, key: "unread_badge_size_large" },
];

const OFFICIAL_COLORS: UnreadBadgeConfig["color"][] = [
  "accent",
  "danger",
  "success",
  "warning",
  "default",
];

export function UnreadBadgeCustomizer() {
  const { t } = useTranslation();
  // 缺省兜底：老库/裸测试环境里这个键可能还不存在，用默认配置（圆点档）渲染，不崩
  const config = useUISettingKey("unreadBadge") ?? DEFAULT_UNREAD_BADGE;
  const { setUnreadBadge } = useUISettingActions();
  // Popover 的开关交给 `Popover.Trigger` 自己管 —— 外面再写 onPress 切换会「开一下又被关一次」
  const [open, setOpen] = useState(false);

  const isDot = config.content === "dot";
  const patch = (next: Partial<UnreadBadgeConfig>) => setUnreadBadge(next);
  /** 圆点档下这几行不生效：整行变淡（控件本身也 isDisabled） */
  const dim = isDot ? "opacity-40" : "";

  return (
    <Popover.Root isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        {/* 效果图里是一颗带文字的胶囊「⚙ 自定义」，不是一个光秃秃的图标钮 */}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("appearance_reading.unread_badge_customize")}
          className={cn(
            "shrink-0 gap-1.5 rounded-full border border-border",
            open && "border-accent text-accent",
          )}
        >
          <Settings2 className="size-3.5" />
          {t("appearance_reading.unread_badge_customize_short")}
        </Button>
      </Popover.Trigger>
      <Popover.Content className="w-[30rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-sm font-medium">
            {t("appearance_reading.unread_badge_title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("appearance_reading.unread_badge_hint")}
          </div>
        </div>

        <div className="max-h-[min(70vh,30rem)] overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
            {/* 位置 —— 四个大格子（预览就是 HeroUI Badge 本身） */}
            <span className={cn("text-xs text-muted-foreground", dim)}>
              {t("appearance_reading.unread_badge_placement")}
            </span>
            <ToggleButtonGroup
              selectionMode="single"
              size="sm"
              className="grid w-full grid-cols-4 gap-2"
              isDisabled={isDot}
              selectedKeys={[config.placement]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next)
                  patch({
                    placement: String(next) as UnreadBadgeConfig["placement"],
                  });
              }}
            >
              {PLACEMENTS.map((placement) => (
                <ToggleButton
                  key={placement}
                  id={placement}
                  // w-full：`.toggle-button` 自带 `width: fit-content`，不顶掉它四格只有 30px 宽
                  className="h-[62px] w-full flex-col gap-1.5 px-1"
                  // 每个格子是一个方向，文字标签由 caption 给，读屏要靠 aria-label
                  aria-label={t(`appearance_reading.${PLACEMENT_KEYS[placement]}`)}
                >
                  <Badge.Anchor className="relative inline-flex">
                    <span className="block size-[22px] rounded-[6px] bg-secondary" />
                    <Badge
                      placement={placement}
                      color="accent"
                      size="sm"
                      variant="primary"
                      className="size-2 min-h-0 min-w-0 rounded-full"
                    />
                  </Badge.Anchor>
                  <span className="text-[11px] leading-none">
                    {t(`appearance_reading.${PLACEMENT_KEYS[placement]}`)}
                  </span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            {/* 大小 —— 三档预设 + 细调滑杆 + 当前值 */}
            <span className={cn("text-xs text-muted-foreground", dim)}>
              {t("appearance_reading.unread_badge_size")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <ToggleButtonGroup
                selectionMode="single"
                size="sm"
                isDisabled={isDot}
                selectedKeys={
                  SIZE_PRESETS.some((preset) => preset.size === config.size)
                    ? [String(config.size)]
                    : []
                }
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (next) patch({ size: Number(next) });
                }}
              >
                {SIZE_PRESETS.map((preset) => (
                  <ToggleButton key={preset.size} id={String(preset.size)}>
                    {t(`appearance_reading.${preset.key}`)} {preset.size}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Slider
                className="min-w-[7rem] flex-1"
                minValue={6}
                maxValue={16}
                step={1}
                value={config.size}
                isDisabled={isDot}
                onChange={(value) =>
                  patch({ size: Array.isArray(value) ? value[0] : value })
                }
                aria-label={t("appearance_reading.unread_badge_size")}
              >
                {/* HeroUI v3 的 Slider 必须自己挂 Track/Fill/Thumb，只写 props 会渲染成一条 4px 空轨道 */}
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {config.size}px
              </span>
            </div>

            {/* 压住边缘 —— 12-2 / 12-14 两轮都在纠的事，做成可调就不用再回来改代码。
                23-5（用户：「现在滑杆只到 6px，要更激进」）：上限 6 → 12px。
                四角对称的 `calc(±100% ∓ offset)` 写法与默认档 2px 都不动（见 unread-indicator.tsx）。 */}
            <span className={cn("text-xs text-muted-foreground", dim)}>
              {t("appearance_reading.unread_badge_offset")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Slider
                className="min-w-[7rem] flex-1"
                minValue={0}
                maxValue={MAX_UNREAD_BADGE_OFFSET}
                step={1}
                value={config.offset}
                isDisabled={isDot}
                onChange={(value) =>
                  patch({ offset: Array.isArray(value) ? value[0] : value })
                }
                aria-label={t("appearance_reading.unread_badge_offset")}
              >
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {config.offset}px
              </span>
              <Chip
                size="sm"
                variant="tertiary"
                className="border border-border text-muted-foreground"
              >
                {t("appearance_reading.unread_badge_offset_hint")}
              </Chip>
            </div>

            {/* 颜色 —— 默认跟随主题色；关掉开关才出现官方色档与取色器 */}
            <span className={cn("text-xs text-muted-foreground", dim)}>
              {t("appearance_reading.unread_badge_color")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <HeroSwitch
                isSelected={config.followAccent}
                isDisabled={isDot}
                aria-label={t("appearance_reading.unread_badge_follow_accent")}
                onChange={(checked: boolean) => patch({ followAccent: checked })}
              >
                <span className="text-xs text-muted-foreground">
                  {t("appearance_reading.unread_badge_follow_accent")}
                </span>
              </HeroSwitch>
              <ColorSwatch
                className={cn(
                  "size-6 rounded-lg border border-border/60",
                  config.followAccent && "opacity-45",
                )}
                style={{
                  backgroundColor: config.followAccent
                    ? "var(--accent)"
                    : (config.customColor ?? "var(--accent)"),
                }}
              />
              {config.followAccent && (
                <Chip
                  size="sm"
                  variant="tertiary"
                  className="border border-border text-muted-foreground"
                >
                  {t("appearance_reading.unread_badge_color_hint")}
                </Chip>
              )}
            </div>

            {!config.followAccent && (
              <>
                <span />
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ToggleButtonGroup
                    selectionMode="single"
                    size="sm"
                    isDisabled={isDot}
                    selectedKeys={[config.color]}
                    onSelectionChange={(keys) => {
                      const next = [...keys][0];
                      if (next)
                        patch({
                          color: String(next) as UnreadBadgeConfig["color"],
                          customColor: null,
                        });
                    }}
                  >
                    {OFFICIAL_COLORS.map((color) => (
                      <ToggleButton key={color} id={color}>
                        {t(`appearance_reading.unread_badge_color_${color}`)}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  {/* 自定义颜色：复用 11-13 / 20-1 那套 HeroUI ColorPicker */}
                  <ColorPicker
                    value={config.customColor ?? "#3b82f6"}
                    onChange={(color) =>
                      patch({ customColor: color.toString("hex") })
                    }
                  >
                    <ColorPicker.Trigger>
                      <ColorSwatch className="size-7 rounded-full border border-border/60" />
                    </ColorPicker.Trigger>
                    <ColorPicker.Popover>
                      <ColorArea
                        colorSpace="hsb"
                        xChannel="saturation"
                        yChannel="brightness"
                        className="max-w-full"
                      >
                        <ColorArea.Thumb />
                      </ColorArea>
                      <ColorSlider channel="hue" colorSpace="hsb" className="w-full">
                        <ColorSlider.Track>
                          <ColorSlider.Thumb />
                        </ColorSlider.Track>
                      </ColorSlider>
                      <ColorField className="w-full">
                        <ColorField.Group variant="secondary" fullWidth>
                          <ColorField.Prefix>
                            <ColorSwatch className="size-5 rounded-full" />
                          </ColorField.Prefix>
                          <ColorField.Input />
                        </ColorField.Group>
                      </ColorField>
                    </ColorPicker.Popover>
                  </ColorPicker>
                </div>
              </>
            )}

            {/* 外观（HeroUI `variant`） */}
            <span className={cn("text-xs text-muted-foreground", dim)}>
              {t("appearance_reading.unread_badge_variant")}
            </span>
            <ToggleButtonGroup
              selectionMode="single"
              size="sm"
              className="w-full [&_button]:flex-1"
              isDisabled={isDot}
              selectedKeys={[config.variant]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next)
                  patch({
                    variant: String(next) as UnreadBadgeConfig["variant"],
                  });
              }}
            >
              <ToggleButton id="primary">
                {t("appearance_reading.unread_badge_variant_primary")}
              </ToggleButton>
              <ToggleButton id="secondary">
                {t("appearance_reading.unread_badge_variant_secondary")}
              </ToggleButton>
              <ToggleButton id="soft">
                {t("appearance_reading.unread_badge_variant_soft")}
              </ToggleButton>
            </ToggleButtonGroup>

            {/* 内容（HeroUI 子节点：空 = 点状 / 数字 / 图标） */}
            <span className="text-xs text-muted-foreground">
              {t("appearance_reading.unread_badge_content")}
            </span>
            <ToggleButtonGroup
              selectionMode="single"
              size="sm"
              className="w-full [&_button]:flex-1"
              selectedKeys={[config.content]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next)
                  patch({
                    content: String(next) as UnreadBadgeConfig["content"],
                  });
              }}
            >
              <ToggleButton id="dot">
                {t("appearance_reading.unread_badge_content_dot")}
              </ToggleButton>
              <ToggleButton id="count">
                {t("appearance_reading.unread_badge_content_count")}
              </ToggleButton>
              <ToggleButton id="icon">
                {t("appearance_reading.unread_badge_content_icon")}
              </ToggleButton>
            </ToggleButtonGroup>
          </div>

          {isDot && (
            <div className="mt-3 text-xs text-muted-foreground">
              {t("appearance_reading.unread_badge_dot_fixed")}
            </div>
          )}

          {/* 实时预览（独占一行，用真组件渲染）+ 底部说明与恢复默认 */}
          <div className="mt-3 border-t border-border pt-3">
            <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-dashed border-border px-3.5 py-3">
              <UnreadIndicator unread count={12}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-[10px] text-muted-foreground">
                  RSS
                </span>
              </UnreadIndicator>
              <span className="min-w-0">
                <span className="block truncate text-[13px]">
                  {t("appearance_reading.unread_badge_preview_title")}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t("appearance_reading.unread_badge_preview_source")}
                </span>
              </span>
              <Chip
                size="sm"
                variant="tertiary"
                className="border border-border text-muted-foreground"
              >
                {t("appearance_reading.unread_badge_preview")}
              </Chip>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {t("appearance_reading.unread_badge_preview_note")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => patch({ ...DEFAULT_UNREAD_BADGE })}
              >
                <RotateCcw className="size-3.5" />
                {t("appearance_reading.unread_badge_reset")}
              </Button>
            </div>
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
