package model

import "time"

type Entry struct {
	ID              int64
	FeedID          int64
	Hash            string
	Title           *string
	URL             *string
	Content         *string
	ReadableContent *string
	ThumbnailURL    *string
	Author          *string
	PublishedAt     *time.Time
	Read            bool
	Starred         bool
	// Muted 由过滤规则写入（静音）：列表默认隐藏，但仍可回看、可反悔。
	Muted bool
	// FilterID 最后命中这条条目的规则 ID（用于「为什么看不到这条」与撤销豁免）。
	FilterID  *int64
	CreatedAt time.Time
	UpdatedAt time.Time
}
