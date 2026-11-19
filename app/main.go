// Krss 的 iOS 客户端外壳：内置 frontend 构建产物，用系统 WebView 打开。
// API 地址在构建前端时通过 VITE_API_URL 注入（见 scripts/build-frontend.sh）。
package main

import (
	"log"

	"github.com/egoist/mygo"
)

func main() {
	mygo.App.SetName("Krss")
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:  "Krss",
			URL:    "/",
			Width:  420,
			Height: 900,
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
