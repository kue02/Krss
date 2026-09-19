package service

import (
	"context"

	"time"

	"gist/backend/internal/model"
)

// RefreshFeedWithFreshClientForTest exposes refreshFeedWithFreshClient for tests.
func RefreshFeedWithFreshClientForTest(svc RefreshService, ctx context.Context, feed model.Feed, userAgent, cookie string, retryCount int) error {
	impl, ok := svc.(*refreshService)
	if !ok {
		return ErrInvalid
	}
	return impl.refreshFeedWithFreshClient(ctx, feed, userAgent, cookie, retryCount, false)
}

// BackoffForFailCountForTest exposes backoffForFailCount for tests.
func BackoffForFailCountForTest(n int) time.Duration {
	return backoffForFailCount(n)
}
