import { Bell, Download, ExternalLink, Sparkles, Star } from "lucide-react";

/**
 * 插件贡献项能用的图标（56-10）。
 *
 * 白名单，**不**按名字动态 import、**不**做任意图标名解析：插件清单是外部数据
 * （http 插件由第三方写），能拼出什么名字就得能加载什么模块的话，等于把打包器
 * 变成一个任意模块加载器。这里只认这几个；未知名字一律返回 null（该项就没有图标），
 * 插件写错了也不会把界面弄崩。
 */
const PLUGIN_ICONS = {
  bell: Bell,
  star: Star,
  download: Download,
  external: ExternalLink,
  sparkles: Sparkles,
} as const;

export type PluginIconName = keyof typeof PLUGIN_ICONS;

export function PluginIcon({
  name,
  className,
}: {
  /** 贡献项声明的图标名（后端 `Contribution.Icon`，可空） */
  name?: string;
  className?: string;
}) {
  if (!name) return null;
  const Icon = PLUGIN_ICONS[name as PluginIconName];
  if (!Icon) return null;
  // 图标只是陪衬：文案才是语义，所以对读屏隐藏
  return <Icon className={className} aria-hidden="true" />;
}
