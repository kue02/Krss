package model

import "time"

type Folder struct {
	ID       int64
	Name     string
	ParentID *int64
	Type     string // article, picture, notification, social
	// 代理覆盖（迁移 26）：nil = 跟随父级文件夹链 → 全局；ProxyConfig 空 = 用全局那套代理。
	ProxyMode   *ProxyMode
	ProxyConfig *ProxyOverrideConfig
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
