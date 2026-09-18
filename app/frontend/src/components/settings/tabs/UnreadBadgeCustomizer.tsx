import { useState } from "react";
import {
  Button,
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Popover,
  Slider,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { RotateCcw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_UNREAD_BADGE,
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
 * 面板本身用 HeroUI `Popover`（不新开抽屉/弹窗，与设置页其它项一致），
 * 排版沿用 13-1 定下的 `标签列 92px + 控件列 1fr`、控件左对齐。
 *
 * 用户 2026-09-18 的裁定：圆点是**默认档**、且是**单独不变的样式** ——
 * 所以选「圆点」时，位置/大小/颜色/外观四项置灰并给出提示（它们只作用于未读数/图标两档）。
 */
export function UnreadBadgeCustomizer() {
  const { t } = useTranslation();
  // 缺省兜底：老库/裸测试环境里这个键可能还不存在，用默认配置（圆点档）渲染，不崩
  const config = useUISettingKey("unreadBadge") ?? DEFAULT_UNREAD_BADGE;
  const { setUnreadBadge } = useUISettingActions();
  const [open, setOpen] = useState(false);

  const isDot = config.content === "dot";
  const patch = (next: Partial<UnreadBadgeConfig>) => setUnreadBadge(next);

  /** 预览用的一小片「图标 + 角标」，与列表里同一套参数 */
  const preview = (
    <span className="relative inline-flex size-5 items-center justify-center rounded-[3px] bg-secondary text-muted-foreground">
      <span className="text-[9px]">RSS</span>
      {config.content === "dot" ? (
        <span className="absolute -left-1 -top-1 size-2 rounded-full bg-accent" />
      ) : (
        <span
          className={cn(
            "absolute flex items-center justify-center rounded-full text-[9px] leading-none",
            config.variant === "soft" ? "bg-accent/25 text-accent" : "bg-accent text-accent-foreground",
          )}
          style={{
            height: config.size,
            minWidth: config.size,
            paddingInline: config.content === "count" ? 4 : 0,
            left: config.placement.includes("left") ? -(4 + config.offset) : undefined,
            right: config.placement.includes("right") ? -(4 + config.offset) : undefined,
            top: config.placement.includes("top") ? -(4 + config.offset) : undefined,
            bottom: config.placement.includes("bottom") ? -(4 + config.offset) : undefined,
          }}
        >
          {config.content === "count" ? "12" : ""}
        </span>
      )}
    </span>
  );

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={t("appearance_reading.unread_badge_customize")}
        className="shrink-0"
        onPress={() => setOpen((v) => !v)}
      >
        <Settings2 className="size-4" />
      </Button>
      <Popover.Content className="w-[22rem] p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="text-sm font-medium">
            {t("appearance_reading.unread_badge_title")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("appearance_reading.unread_badge_hint")}
          </div>
        </div>

        <div className="max-h-[22rem] overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-x-3 gap-y-[7px]">
            {/* 内容 */}
            <span className="text-xs text-muted-foreground">
              {t("appearance_reading.unread_badge_content")}
            </span>
            <ToggleButtonGroup
              selectionMode="single"
              size="sm"
              selectedKeys={[config.content]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next) patch({ content: String(next) as UnreadBadgeConfig["content"] });
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

            {/* 位置（四档） */}
            <span className={cn("text-xs text-muted-foreground", isDot && "opacity-40")}>
              {t("appearance_reading.unread_badge_placement")}
            </span>
            <ToggleButtonGroup
              selectionMode="single"
              size="sm"
              className="w-full [&_button]:flex-1"
              isDisabled={isDot}
              selectedKeys={[config.placement]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next) patch({ placement: String(next) as UnreadBadgeConfig["placement"] });
              }}
            >
              <ToggleButton id="top-left">↖</ToggleButton>
              <ToggleButton id="top-right">↗</ToggleButton>
              <ToggleButton id="bottom-left">↙</ToggleButton>
              <ToggleButton id="bottom-right">↘</ToggleButton>
            </ToggleButtonGroup>

            {/* 大小 */}
            <span className={cn("text-xs text-muted-foreground", isDot && "opacity-40")}>
              {t("appearance_reading.unread_badge_size")}
            </span>
            <div className="flex items-center gap-3">
              <Slider
                className="min-w-0 flex-1"
                minValue={6}
                maxValue={16}
                step={1}
                value={config.size}
                isDisabled={isDot}
                onChange={(value) => patch({ size: Array.isArray(value) ? value[0] : value })}
                aria-label={t("appearance_reading.unread_badge_size")}
              />
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {config.size}px
              </span>
            </div>

            {/* 颜色 */}
            <span className={cn("text-xs text-muted-foreground", isDot && "opacity-40")}>
              {t("appearance_reading.unread_badge_color")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Switch
                isSelected={config.followAccent}
                isDisabled={isDot}
                onChange={(checked: boolean) => patch({ followAccent: checked })}
              />
              <span className="text-xs text-muted-foreground">
                {t("appearance_reading.unread_badge_follow_accent")}
              </span>
              {!config.followAccent && (
                <>
                  <ToggleButtonGroup
                    selectionMode="single"
                    size="sm"
                    isDisabled={isDot}
                    selectedKeys={[config.color]}
                    onSelectionChange={(keys) => {
                      const next = [...keys][0];
                      if (next) patch({ color: String(next) as UnreadBadgeConfig["color"], customColor: null });
                    }}
                  >
                    {(["accent", "danger", "success", "warning", "default"] as const).map((c) => (
                      <ToggleButton key={c} id={c}>
                        {t(`appearance_reading.unread_badge_color_${c}`)}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  {/* 自定义颜色：复用 11-13 的 HeroUI ColorPicker */}
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
                      <div className="w-56 space-y-3 p-3">
                        <ColorArea
                          colorSpace="hsb"
                          xChannel="saturation"
                          yChannel="brightness"
                          className="w-full"
                        >
                          <ColorArea.Thumb />
                        </ColorArea>
                        <ColorSlider channel="hue" colorSpace="hsb">
                          <ColorSlider.Track>
                            <ColorSlider.Thumb />
                          </ColorSlider.Track>
                        </ColorSlider>
                      </div>
                    </ColorPicker.Popover>
                  </ColorPicker>
                </>
              )}
            </div>

            {/* 外观 */}
            <span className={cn("text-xs text-muted-foreground", isDot && "opacity-40")}>
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
                if (next) patch({ variant: String(next) as UnreadBadgeConfig["variant"] });
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

            {/* 压住边缘 */}
            <span className={cn("text-xs text-muted-foreground", isDot && "opacity-40")}>
              {t("appearance_reading.unread_badge_offset")}
            </span>
            <div className="flex items-center gap-3">
              <Slider
                className="min-w-0 flex-1"
                minValue={0}
                maxValue={6}
                step={1}
                value={config.offset}
                isDisabled={isDot}
                onChange={(value) => patch({ offset: Array.isArray(value) ? value[0] : value })}
                aria-label={t("appearance_reading.unread_badge_offset")}
              />
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {config.offset}px
              </span>
            </div>
          </div>

          {isDot && (
            <div className="mt-3 text-xs text-muted-foreground">
              {t("appearance_reading.unread_badge_dot_fixed")}
            </div>
          )}

          {/* 实时预览 + 恢复默认 */}
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <div className="flex items-center gap-2">
              {preview}
              <span className="text-xs text-muted-foreground">
                {t("appearance_reading.unread_badge_preview")}
              </span>
            </div>
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
      </Popover.Content>
    </Popover>
  );
}
