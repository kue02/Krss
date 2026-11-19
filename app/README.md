# Krss iOS 客户端（MyGo 薄壳）

这个目录把现有的 React 前端包成可在 iPhone 上安装的 App，不重写 UI，也不改后端业务逻辑。

## 前置条件

- macOS + Xcode（命令行工具已 `xcode-select`）
- `mygo` CLI：`go install github.com/egoist/mygo/cmd/mygo@latest`
- iOS 设备开启「开发者模式」，并在 Xcode → Settings → Accounts 登录 Apple ID（免费 Personal Team 即可）

## 构建网页

前端通过 `VITE_API_URL` 在构建期写入你的 Krss 服务器地址：

```sh
cd app
KRSS_SERVER_URL="http://192.168.1.10:8090" sh scripts/build-frontend.sh
```

必须设置 `KRSS_SERVER_URL`，脚本会把它写进前端构建产物；不设置会直接报错退出，避免打出装上无法登录的包。开发热更新用下面的 `mygo dev`，不需要这个变量。

## 开发（真机热更新）

```sh
cd app
KRSS_DEV_BACKEND="http://localhost:8090" mygo dev -platform ios -device "你的 iPhone 名称或 UDID"
```

`mygo dev` 会把 `devUrl` 的 localhost 自动改写成 Mac 的局域网地址；Mac 和 iPhone 要在同一网络。
开发包 identifier 是 `com.kue02.krss.dev`，使用 7 天有效的免费开发签名。

## 打生产安装包（不上架）

```sh
cd app
KRSS_SERVER_URL="http://192.168.1.10:8090" mygo build -platform ios
open dist/ios-arm64
```

`mygo build` 只产出 `.ipa`，`devicectl` 需要 `.app`，先解压再装：

```sh
rm -rf /tmp/krss-ipa && mkdir -p /tmp/krss-ipa
unzip -q dist/ios-arm64/krss-*.ipa -d /tmp/krss-ipa
xcrun devicectl device install app --device <UDID> /tmp/krss-ipa/Payload/Krss.app
```

也可以把 `.ipa` 拖进 Xcode → Window → Devices and Simulators，或用 Apple Configurator 安装。

首次启动前要在 iPhone「设置 → 通用 → VPN 与设备管理」里信任开发者的描述文件，否则系统会报 `profile has not been explicitly trusted`。

## 7 天重签

免费 Personal Team 的签名 7 天到期，到期后 App 无法启动。每 7 天在 Mac 上重跑一次：

```sh
cd app
KRSS_SERVER_URL="http://你的服务器地址:8090" mygo build -platform ios
# 再按上面「打生产安装包」的步骤解压并 devicectl install
```

`sh scripts/build-install-ios.sh <UDID> <服务器地址>` 会把构建、解压、安装一次做完。

## 服务器地址与 HTTP

`mygo.json` 的 `ios.infoPlist` 已加入：

- `NSAppTransportSecurity.NSAllowsArbitraryLoads`：允许连自托管的 HTTP 服务器
- `NSLocalNetworkUsageDescription`：iOS 首次连局域网时的权限说明

如果服务器用 HTTPS，可以把 `NSAllowsArbitraryLoads` 去掉，更安全。

`mygo.json` 不写死 `ios.team`：mygo 按 `com.kue02.krss` 匹配本机 Xcode 账号生成的 Personal Team 描述文件。换一台 Mac 只需在 Xcode 登录自己的 Apple ID。`NSAllowsArbitraryLoads` 是为了兼容用户自托管服务器可能使用任意 HTTP 地址；若你的服务器固定用 HTTPS，可按需收窄。

## 图标

`resources/icon.png` 为 1024×1024、无透明通道，取自 `frontend/public/logo.svg` 的品牌色与字形。
