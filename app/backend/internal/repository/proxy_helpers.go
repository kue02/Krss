package repository

import (
	"database/sql"
	"encoding/json"
	"strings"

	"krss/backend/internal/model"
)

// 代理按来源生效（迁移 26）：feeds / folders 各两列。
// proxy_mode 用 INTEGER 存三态（NULL = 跟随上级）；proxy_config 用 JSON 存「这一层单独指定的一套代理」。

// parseProxyMode 把 proxy_mode 列转成三态；NULL → nil（跟随上级）。
func parseProxyMode(v sql.NullInt64) *model.ProxyMode {
	if !v.Valid {
		return nil
	}
	mode := model.ProxyModeProxy
	if v.Int64 == int64(model.ProxyModeDirect) {
		mode = model.ProxyModeDirect
	}
	return &mode
}

// parseProxyConfig 解析 proxy_config JSON 列。
// 空 / NULL / 坏 JSON 一律当「没配」（退回全局那套）：坏 JSON 不该让整条订阅读不出来。
func parseProxyConfig(raw sql.NullString) *model.ProxyOverrideConfig {
	if !raw.Valid || strings.TrimSpace(raw.String) == "" {
		return nil
	}
	var cfg model.ProxyOverrideConfig
	if err := json.Unmarshal([]byte(raw.String), &cfg); err != nil {
		return nil
	}
	return &cfg
}

// marshalProxyConfig 序列化代理覆盖配置；nil → NULL。
func marshalProxyConfig(cfg *model.ProxyOverrideConfig) (any, error) {
	if cfg == nil {
		return nil, nil
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	return string(data), nil
}

// nullableProxyMode 把三态写进列（nil → NULL）。
func nullableProxyMode(mode *model.ProxyMode) any {
	if mode == nil {
		return nil
	}
	return int64(*mode)
}
