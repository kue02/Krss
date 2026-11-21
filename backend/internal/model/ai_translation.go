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
	Status   string
	Error    string
	Service  string // 翻译所用服务名（如「Google 翻译」/「有道翻译」/模型名）
	Provider string // 服务提供商
	Model    string // 若走模型：模型名
}

// AISummaryStatus 单条 AI 摘要的生成状态与所用模型信息（列表展示「摘要中/已完成/失败」用）。
type AISummaryStatus struct {
	Status   string
	Error    string
	Provider string
	Model    string
}
