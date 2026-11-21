package model

import "time"

type AITranslation struct {
	ID            int64
	EntryID       int64
	IsReadability bool
	Language      string
	Content       string
	CreatedAt     time.Time
}

// AITranslationStatus 单条译文的翻译状态（列表展示「翻译中 / 已完成 / 失败」用）。
// 与 AITranslation 分开放：状态随翻译过程变化，译文内容只在成功时写一次。
type AITranslationStatus struct {
	Status string
	Error  string
}
