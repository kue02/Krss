package model

import "time"

// AIListTranslation stores cached title and summary translations for list view.
type AIListTranslation struct {
	ID        int64
	EntryID   int64
	Language  string
	Title     string
	Summary   string
	// Provider / Model 记录这条列表译文实际用了哪个提供商/模型（迁移 38），
	// 列表卡片的「摘要」徽标完成态据此显示。
	Provider  string
	Model     string
	CreatedAt time.Time
}
