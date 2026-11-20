#!/bin/sh
# 构建前端并注入 API 基址。
# 用法：KRSS_SERVER_URL="http://192.168.1.10:8090" sh scripts/build-frontend.sh
# 必须设置 KRSS_SERVER_URL，否则直接失败，避免打出 API 基址为空、装上也无法登录的包。
set -eu
cd "$(dirname "$0")/.."   # app/
cd ../frontend
if [ -z "${KRSS_SERVER_URL:-}" ]; then
  echo "[krss] 错误：必须用 KRSS_SERVER_URL 指定 Krss 服务器地址，例如 KRSS_SERVER_URL=http://192.168.1.10:8090 mygo build -platform ios" >&2
  exit 1
fi
echo "[krss] building frontend with VITE_API_URL=$KRSS_SERVER_URL"
VITE_API_URL="$KRSS_SERVER_URL" bun run build
