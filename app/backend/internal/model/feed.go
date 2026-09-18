package model

import "time"

type Feed struct {
	ID                    int64
	FolderID              *int64
	Title                 string
	URL                   string
	SiteURL               *string
	Description           *string
	SummaryPromptReminder *string
	// 订阅级覆盖：nil = 跟随全局设置
	AutoTranslate *bool
	AutoSummary   *bool
	// ReaderMode：正文打开方式，nil = 跟随全局设置；true = 阅读模式，false = 原文
	ReaderMode *bool
	// 代理覆盖（迁移 26）：nil = 跟随文件夹链 → 全局；ProxyConfig 空 = 用全局那套代理。
	ProxyMode   *ProxyMode
	ProxyConfig *ProxyOverrideConfig
	IconPath    *string
	Type        string // article, picture, notification, social
	// SourceType：这条订阅「怎么取数」——rss（默认）/ mcp（16 批：MCP 取到的内容当 Feed 处理）。
	// 老数据是列默认值 'rss' ⇒ 行为零变化。
	SourceType string
	// MCPConfig：仅 SourceType = 'mcp' 时有值，存 mcp_config JSON（连接 id + 工具/资源 + 参数 + 字段映射）。
	MCPConfig    *string
	ETag         *string
	LastModified *string
	ErrorMessage *string
	// 刷新失败退避（22-4）：连续失败次数（成功一次清零）与最近一次失败时间。
	// 定时刷新用它们算「下次允许抓取」的时间点，连续失败的源自动降频。
	RefreshFailCount  int
	RefreshLastFailAt *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// 订阅的取数来源（feeds.source_type）。
const (
	FeedSourceRSS = "rss"
	FeedSourceMCP = "mcp"
)

// IsMCP 这条订阅是否走 MCP 取数（抓取分叉判据）。
func (f Feed) IsMCP() bool {
	return f.SourceType == FeedSourceMCP
}
