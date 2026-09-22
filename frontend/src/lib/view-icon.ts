import {
  Bell,
  Bookmark,
  Briefcase,
  Camera,
  Code,
  Compass,
  Flame,
  Folder,
  Hash,
  Heart,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  Music,
  Newspaper,
  Rss,
  Search,
  Star,
  Tag,
  Video,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * 视图的自定义图标（用户 11-5）。
 *
 * 存库格式三种，前后端一致（后端 `normalizeViewIcon` 只认这三种前缀，别的会被清掉）：
 *   `builtin:<key>`   —— 下面这张表里的内置图标（用 lucide，和界面其它图标同一套）
 *   `emoji:<字符>`    —— 任意 emoji
 *   `data:image/...`  —— 上传的图片（前端 128px 缩放后的 data URL，与头像同一套做法）
 *
 * 为什么不做「任意图标名」：图标要能渲染出来才有意义，允许自由字符串的话库里会攒下
 * 一堆前端不认识的 key，界面上表现为白板（本项目之前踩过「图标白板」）。
 */
export const VIEW_ICONS: { key: string; label: string; Icon: LucideIcon }[] = [
  { key: "star", label: "收藏", Icon: Star },
  { key: "bookmark", label: "书签", Icon: Bookmark },
  { key: "folder", label: "文件夹", Icon: Folder },
  { key: "tag", label: "标签", Icon: Tag },
  { key: "hash", label: "话题", Icon: Hash },
  { key: "rss", label: "订阅", Icon: Rss },
  { key: "newspaper", label: "资讯", Icon: Newspaper },
  { key: "compass", label: "发现", Icon: Compass },
  { key: "search", label: "筛选", Icon: Search },
  { key: "layers", label: "分类", Icon: Layers },
  { key: "flame", label: "热门", Icon: Flame },
  { key: "zap", label: "快讯", Icon: Zap },
  { key: "lightbulb", label: "灵感", Icon: Lightbulb },
  { key: "briefcase", label: "工作", Icon: Briefcase },
  { key: "code", label: "代码", Icon: Code },
  { key: "image", label: "图片", Icon: ImageIcon },
  { key: "video", label: "视频", Icon: Video },
  { key: "music", label: "音乐", Icon: Music },
  { key: "camera", label: "摄影", Icon: Camera },
  { key: "bell", label: "提醒", Icon: Bell },
  { key: "heart", label: "喜欢", Icon: Heart },
];

export const BUILTIN_VIEW_ICONS: Record<string, LucideIcon> = Object.fromEntries(
  VIEW_ICONS.map((item) => [item.key, item.Icon]),
);

/** 常用 emoji，省得用户自己敲（仍能手输任意 emoji） */
export const VIEW_EMOJIS = [
  "⭐", "🔥", "📌", "📰", "🧠", "💡", "🎯", "🚀", "📈", "💰",
  "🛠️", "🎨", "🎬", "🎧", "📚", "🧪", "🌱", "☕", "🐦", "🧩",
];

/** 给选择器底部那行小字用（说明存的是什么格式） */
export const PARSE_HINT = "内置 / emoji / 上传三种都可，随时可清空";

export type ViewIconKind = "builtin" | "emoji" | "image" | "none";

/** 解析存库的图标串；认不出来一律当「没设图标」（界面回落到默认图标）。 */
export function parseViewIcon(icon?: string | null): {
  kind: ViewIconKind;
  value: string;
} {
  const raw = (icon ?? "").trim();
  if (!raw) return { kind: "none", value: "" };
  if (raw.startsWith("builtin:")) {
    const key = raw.slice("builtin:".length);
    return BUILTIN_VIEW_ICONS[key] ? { kind: "builtin", value: key } : { kind: "none", value: "" };
  }
  if (raw.startsWith("emoji:")) {
    const value = raw.slice("emoji:".length);
    return value ? { kind: "emoji", value } : { kind: "none", value: "" };
  }
  if (raw.startsWith("data:image/")) return { kind: "image", value: raw };
  return { kind: "none", value: "" };
}
