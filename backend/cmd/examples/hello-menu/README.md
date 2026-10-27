# hello-menu —— 最小外部插件示例

条目右键菜单里加一项「打个招呼」。不读库、不发网络、不存数据，只演示**最少要写哪几样**：

| 要写的 | 作用 |
|---|---|
| `Meta()` | 插件身份；`ID` 决定数据隔离与目录名 |
| `Actions()` | 动作（规则可引用，界面直调也走它） |
| `Contributions()` | 在哪个界面挂点、显示什么文字（声明式，宿主用 HeroUI 画） |
| `Invoke()` | 界面点下去时宿主调用它，返回的 `message` 弹成提示 |

## 装

```bash
cd backend
go build -o /tmp/hello-menu ./cmd/examples/hello-menu
mkdir -p "$KRSS_DATA_DIR/plugins/hello-menu"
cp /tmp/hello-menu plugin.json "$KRSS_DATA_DIR/plugins/hello-menu/"
```

4~5 秒内宿主自己发现并 spawn（不用重启）。条目右键菜单出现「打个招呼」。

## 卸

删掉 `$KRSS_DATA_DIR/plugins/hello-menu/` 整个目录即可。

## 验（本机实测过的形状）

```bash
# 1. 贡献清单里有它
curl -s -H "Authorization: Bearer $T" http://localhost:8082/api/plugins/contributions

# 2. 直调
curl -s -X POST http://localhost:8082/api/plugins/hello-menu/actions/hi/invoke \
  -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"surface":"entry.contextmenu","selection":{"entryIds":["<条目id>"]}}'
# → {"message":"你好，条目 <条目id>","level":"success"}
```
