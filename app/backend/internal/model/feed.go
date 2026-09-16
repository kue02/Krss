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
	ReaderMode    *bool
	IconPath              *string
	Type                  string // article, picture, notification, social
	ETag                  *string
	LastModified          *string
	ErrorMessage          *string
	CreatedAt             time.Time
	UpdatedAt             time.Time
}
