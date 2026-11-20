import { forwardRef } from "react";
import { useAuthedImageUrl } from "@/lib/use-authed-image";

/**
 * 与 `<img>` 用法一致，但 App 模式下会带 token 取回 `/api/proxy/*` 图片再转 blob:。
 * 纯网页同源构建时行为与原生 `<img>` 完全相同。
 */
export const AuthedImage = forwardRef<
  HTMLImageElement,
  React.ImgHTMLAttributes<HTMLImageElement>
>(function AuthedImage({ src, ...rest }, ref) {
  const resolved = useAuthedImageUrl(typeof src === "string" ? src : undefined);
  return <img ref={ref} src={resolved} {...rest} />;
});
