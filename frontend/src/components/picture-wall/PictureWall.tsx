/**
 * 图片视图 · 第四档「照片墙」（31-1）
 *
 * 铺的是**照片本身**，不按条目分组（用户原话：「这个就按照照片来吧，有多少照片就铺多少张，
 * 不需要按照条目一条一条的」）—— 把当前视图已加载条目的照片按顺序去重收一遍，
 * 封顶 `WALL_MAX_TILES` 张（图集张数平方增长，超了显存顶不住），交给
 * `components/block/art-gallery.tsx`（obsidianui art-gallery 原件）。
 *
 * `three` 走 `React.lazy` 动态 import ⇒ 只在真开这一档时才加载，其它视图首屏包不变。
 */
import { Suspense, lazy, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getEntryImages } from "@/lib/extract-images";
import { collectWallPhotos, WALL_MAX_TILES } from "@/lib/picture-wall";
import type { Entry, Feed } from "@/types/api";

/** three.js 只在开这一档时加载 */
const ArtGallery = lazy(() => import("@/components/block/art-gallery"));

interface PictureWallProps {
  items: { entry: Entry; feed?: Feed }[];
  className?: string;
}

function WallSpinner() {
  return (
    <div
      data-picture-wall-loading="true"
      className="flex h-full w-full items-center justify-center bg-black"
    >
      <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

export function PictureWall({ items, className }: PictureWallProps) {
  const { t } = useTranslation();

  const photos = useMemo(() => {
    const urls: string[] = [];
    for (const { entry } of items) {
      urls.push(
        ...getEntryImages(entry.thumbnailUrl, entry.content, entry.url ?? undefined),
      );
    }
    return collectWallPhotos(urls);
  }, [items]);

  /* 照片集变了就重挂载画廊（图集要整块重做；见 art-gallery.tsx 的 ready 注释） */
  const sceneKey = useMemo(() => photos.join("|"), [photos]);

  return (
    <div
      data-picture-wall="true"
      data-picture-wall-count={photos.length}
      data-picture-wall-max={WALL_MAX_TILES}
      className={className ?? "h-full w-full"}
    >
      {photos.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center bg-black text-sm text-white/40">
          {t("appearance_view.picture_wall_empty")}
        </div>
      ) : (
        <Suspense fallback={<WallSpinner />}>
          <ArtGallery
            key={sceneKey}
            images={photos}
            hint={t("appearance_view.picture_wall_hint")}
            unsupportedNote={t("appearance_view.picture_wall_no_webgl")}
            className="h-full w-full"
          />
        </Suspense>
      )}
    </div>
  );
}
