import { useTranslation } from "react-i18next";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import { contentTypeMeta } from "@/lib/content-type-meta";
import type { ContentType } from "@/types/api";

interface ContentTypeSwitcherProps {
  contentType: ContentType;
  counts: {
    article: number;
    picture: number;
    notification: number;
    social: number;
  };
  onSelect: (type: ContentType) => void;
  visibleContentTypes: ContentType[];
}

/** 内容类型切换 —— Nextflux 风格的分段胶囊：整条浅底容器，选中项浮起成卡片 */
export function ContentTypeSwitcher({
  contentType,
  counts,
  onSelect,
  visibleContentTypes,
}: ContentTypeSwitcherProps) {
  const { t } = useTranslation();

  return (
    <div className="relative mb-1 mt-2 px-1">
      <div className="flex h-12 items-center gap-1 rounded-xl bg-secondary/50 p-1">
        {visibleContentTypes.map((type) => {
          const { icon: Icon, labelKey } = contentTypeMeta[type];
          const isActive = contentType === type;
          return (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className={cn(
                "relative flex h-full shrink-0 grow flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg transition-all duration-200",
                isActive
                  ? "bg-card text-foreground shadow-nf"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={t(labelKey)}
            >
              <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />
              <Icon
                className={cn("size-[1.125rem]", isActive && "text-primary")}
              />
              <div className="text-[0.625rem] font-medium leading-none tabular-nums">
                {counts[type]}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
