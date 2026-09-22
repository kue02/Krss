package model

import (
	"fmt"
	"net/url"
	"strings"
)

// ProxyMode 订阅 / 文件夹上的代理三态（与 auto_translate / reader_mode 同一套语汇）。
//
//	nil（列 NULL）= 跟随上级：订阅 → 文件夹（含父级链）→ 全局
//	ProxyModeProxy = 走代理
//	ProxyModeDirect = 直连
type ProxyMode int

const (
	ProxyModeDirect ProxyMode = 0
	ProxyModeProxy  ProxyMode = 1
)

// ProxyOverrideConfig 某一层（订阅 / 文件夹）单独指定的一套代理。
// 空（nil）= 用全局那套；仅当这一层选了「走代理」时才有意义。
//
// Password 属凭证：存库可以，接口返回一律掩码、日志一律不落（照 GetNetworkSettings 那套）。
type ProxyOverrideConfig struct {
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// Usable 这一层单独指定的那套代理是否可用（有地址有端口才算配了）。
func (c *ProxyOverrideConfig) Usable() bool {
	return c != nil && strings.TrimSpace(c.Host) != "" && c.Port > 0
}

// URL 拼出可直接使用的代理地址；不可用时返回空串。
func (c *ProxyOverrideConfig) URL() string {
	if !c.Usable() {
		return ""
	}
	proxyType := strings.TrimSpace(c.Type)
	if proxyType == "" {
		proxyType = "http"
	}
	host := strings.TrimSpace(c.Host)
	if c.Username != "" && c.Password != "" {
		return fmt.Sprintf("%s://%s:%s@%s:%d",
			proxyType,
			url.QueryEscape(c.Username),
			url.QueryEscape(c.Password),
			host,
			c.Port,
		)
	}
	return fmt.Sprintf("%s://%s:%d", proxyType, host, c.Port)
}
