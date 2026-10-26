// Command annotate 是一个**外部插件**（56-30 样板）：编成可执行 + plugin.json，
// 放进 $KRSS_DATA_DIR/plugins/annotate/ 就能用 —— 宿主 spawn 它、经 Unix socket 说同一套协议。
//
// 自己跑是跑不起来的（要有宿主注入的 KRSS_PLUGIN_SOCKET/TOKEN），这正是外部插件的前提：
//
//	go build -o annotate ./cmd/examples/annotate
//	cp annotate plugin.json $KRSS_DATA_DIR/plugins/annotate/   # plugin.json 与二进制并排
package main

import (
	"context"
	"log"

	"krss/backend/internal/plugin/sdk"
)

func main() {
	if err := sdk.Serve(context.Background(), annotate{}); err != nil {
		log.Fatalf("annotate: %v", err)
	}
}
