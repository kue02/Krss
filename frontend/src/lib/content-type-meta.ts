import {
  BellIcon,
  FileTextIcon,
  ImageIcon,
  SocialIcon,
} from "@/components/ui/icons";
import type { ContentType } from "@/types/api";

/**
 * 内容类型 → 图标 + 文案键。
 *
 * 抽出来是因为它出现在两处：中栏的类型切换器（ContentTypeSwitcher）与
 * 订阅右键的「更改类型」（用户第十一批 11-6：右键菜单也要显示视图图标）。
 * 两处必须同一套图标，否则同一个类型在两个地方长得不一样。
 */
export const CONTENT_TYPE_ORDER: ContentType[] = [
  "article",
  "social",
  "picture",
  "notification",
];

export const contentTypeMeta: Record<
  ContentType,
  { icon: typeof FileTextIcon; labelKey: string }
> = {
  article: { icon: FileTextIcon, labelKey: "content_type.article" },
  picture: { icon: ImageIcon, labelKey: "content_type.picture" },
  notification: { icon: BellIcon, labelKey: "content_type.notification" },
  social: { icon: SocialIcon, labelKey: "content_type.social" },
};
