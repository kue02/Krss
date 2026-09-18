package service

import (
	"errors"

	"gist/backend/internal/model"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrInvalid   = errors.New("invalid")
	ErrFeedFetch = errors.New("feed fetch failed")
	// ErrUnknownSettingKey 导入设置时出现白名单以外的键（21 批）——
	// 单独一个错误是为了给前端一句能看懂的话（列出到底哪个键不认），而不是笼统的 400。
	ErrUnknownSettingKey = errors.New("unknown setting key")
)

// FeedConflictError is returned when a feed URL already exists.
type FeedConflictError struct {
	ExistingFeed model.Feed
}

func (e *FeedConflictError) Error() string {
	return "feed already exists"
}

func (e *FeedConflictError) Is(target error) bool {
	return target == ErrConflict
}
