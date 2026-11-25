package scheduler_test

import (
	"krss/backend/internal/scheduler"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/service/mock"
)

func TestScheduler(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockRefresh := mock.NewMockRefreshService(ctrl)

	// RefreshAll should be called once immediately on Start
	mockRefresh.EXPECT().RefreshAllAuto(gomock.Any()).Return(nil).AnyTimes()

	// 间隔现在是一个 getter（用户 11-20：每轮重读设置），测试里固定成 100ms
	s := scheduler.New(mockRefresh, func() time.Duration { return 100 * time.Millisecond })
	s.Start()

	// Let it run for a bit
	time.Sleep(250 * time.Millisecond)

	s.Stop()
	require.True(t, true) // If we reach here without panic/deadlock, it's good
}

// 轮级抖动：给定 jitterFn，返回的下一轮等待必须落在 [base, base+60s] 内。
func TestScheduler_RoundDelay(t *testing.T) {
	base := 100 * time.Millisecond

	// jitterFn 返回 0 → 正好等于 base
	require.Equal(t, base, scheduler.RoundDelay(base, func(time.Duration) time.Duration { return 0 }))

	// jitterFn 返回上限 min(base/10, 60s) → 落在 [base, base+60s]
	capped := scheduler.RoundDelay(base, func(b time.Duration) time.Duration {
		limit := b / 10
		if limit > time.Minute {
			limit = time.Minute
		}
		return limit
	})
	require.GreaterOrEqual(t, capped, base)
	require.LessOrEqual(t, capped, base+time.Minute)

	// 默认真随机抖动也始终落在 [base, base+60s]
	for i := 0; i < 50; i++ {
		d := scheduler.RoundDelay(base, nil)
		require.GreaterOrEqual(t, d, base)
		require.LessOrEqual(t, d, base+time.Minute)
	}
}

// 注入返回 0 的抖动函数后，调度器照常按间隔循环（不应因抖动改造而卡死）。
func TestScheduler_SetJitterDisablesJitter(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockRefresh := mock.NewMockRefreshService(ctrl)
	mockRefresh.EXPECT().RefreshAllAuto(gomock.Any()).Return(nil).AnyTimes()

	s := scheduler.New(mockRefresh, func() time.Duration { return 50 * time.Millisecond })
	s.SetJitter(func(time.Duration) time.Duration { return 0 })
	s.Start()
	time.Sleep(120 * time.Millisecond)
	s.Stop()
	require.True(t, true)
}
