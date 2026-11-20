#!/bin/sh
# 打真机生产包并安装到 iPhone。
# 用法：sh scripts/build-install-ios.sh <UDID> <服务器地址>
# 例：sh scripts/build-install-ios.sh 00008110-000C48992E0A801E http://192.168.5.12:8090
set -eu
if [ "$#" -lt 2 ]; then
  echo "用法：sh scripts/build-install-ios.sh <UDID> <服务器地址>" >&2
  exit 2
fi
UDID="$1"
SERVER_URL="$2"
cd "$(dirname "$0")/.."   # app/

KRSS_SERVER_URL="$SERVER_URL" mygo build -platform ios

IPA=$(ls -t dist/ios-arm64/*.ipa | head -1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"
xcrun devicectl device install app --device "$UDID" "$TMP/Payload/Krss.app"
echo "已安装 $IPA。首次启动前请到 iPhone「设置 → 通用 → VPN 与设备管理」信任开发者描述文件。"
