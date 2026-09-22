import type { ComponentType } from "react";
import { CheckCircleIcon, CircleOutlineIcon } from "@/components/ui/icons";

/**
 * 23-2：「标为已读 / 标为未读」这一对动作的**唯一一份定义**。
 *
 * 三处入口共用它，避免各自写一遍图标与文案后漂成两个样子：
 *   ① 条目卡片右键菜单（`EntryListItem` 的 `EntryContextMenuContent`）
 *   ② 正文工具栏（`EntryContentHeader`）
 *   ③ 社交媒体条目的悬停操作条（`EntryListItem` 的社交分支）
 *
 * 图标沿用项目自己的图标集（`components/ui/icons`），与中栏那两颗「未读筛选 / 全部标记已读」
 * 同形：未读 = 描边圆、已读 = 对勾圆 —— 用户一眼能对上是同一件事。
 *
 * `nextRead` 是**点击后要写进去的值**（不是当前状态）：未读的条目点了就变已读。
 */
export interface ReadToggleAction {
  /** 点击后写入 `read` 的值 */
  nextRead: boolean;
  /** 动作图标（与动作语义一致：标已读给对勾圆、标未读给描边圆） */
  Icon: ComponentType<{ className?: string }>;
  /** 动作文案的 i18n 键（`entry.mark_read` / `entry.mark_unread`） */
  labelKey: "entry.mark_read" | "entry.mark_unread";
}

export function readToggleAction(isUnread: boolean): ReadToggleAction {
  return isUnread
    ? { nextRead: true, Icon: CheckCircleIcon, labelKey: "entry.mark_read" }
    : { nextRead: false, Icon: CircleOutlineIcon, labelKey: "entry.mark_unread" };
}
