/**
 * 把用户选的图片压到最长边 maxSize 的 data URL（用户上传头像 / 视图图标共用）。
 * 抽出来是因为头像那套原来写在 ProfileSettings 里，视图图标（11-5）要用同一套规格，
 * 两处各写一份迟早漂（缩放尺寸、格式、质量任一处不同，视觉就不一致）。
 */
export async function downscaleImage(file: File, maxSize: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL("image/png");
}
