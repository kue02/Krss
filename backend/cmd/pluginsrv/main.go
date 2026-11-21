// Command pluginsrv 外部插件壳（55-7c）。
//
// 用法：把任何一个实现了 plugin.Plugin 的包交给 sdk.Serve，编成这个二进制，
// 连同 plugin.json（manifest）一起放进 $KRSS_DATA_DIR/plugins/<id>/，krss 宿主即装即用。
//
// v1 内置示例：把 demo 样板插件编成外部版，证明同一份契约代码两条轨都能跑。
// 你自己的插件：把 import 换成你的包、sdk.Serve(你的插件) 即可（见 docs/dev/插件模块.md）。
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	demoplugin "krss/backend/cmd/examples/demo"
	"krss/backend/internal/plugin/sdk"
	"krss/backend/pkg/logger"
)

func main() {
	logger.Init(logger.ParseLevel(os.Getenv("KRSS_PLUGIN_LOG_LEVEL")))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := sdk.Serve(ctx, demoplugin.New()); err != nil {
		logger.Error("pluginsrv exited", "module", "pluginsrv", "action", "serve", "result", "failed", "error", err)
		os.Exit(1)
	}
}
