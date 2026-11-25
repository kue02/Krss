package scheduler

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"

	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

// JitterFunc 计算下一轮等待在 base 之上额外叠加的随机抖动；返回 0 表示不抖动。
type JitterFunc func(base time.Duration) time.Duration

// maxJitter 轮级抖动的安全上限（抖动本身还会被 base/10 进一步收窄）。
const maxJitter = 60 * time.Second

// defaultJitter 在 [0, min(base/10, 60s)] 里取随机抖动，用于把多个实例/多轮的刷新时刻错开。
func defaultJitter(base time.Duration) time.Duration {
	if base <= 0 {
		return 0
	}
	limit := base / 10
	if limit > maxJitter {
		limit = maxJitter
	}
	if limit <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(limit) + 1))
}

// RoundDelay 返回下一轮的实际等待 = base + jitter(base)。
// 独立成函数便于单测：给定 jitterFn，断言结果落在 [base, base+maxJitter] 内。
func RoundDelay(base time.Duration, jitter JitterFunc) time.Duration {
	if jitter == nil {
		jitter = defaultJitter
	}
	return base + jitter(base)
}

type Scheduler struct {
	refreshService service.RefreshService
	// getInterval 每轮重新读一次间隔（用户 11-20：拉取频率可配置，改完下一轮生效、不用重启）
	getInterval func() time.Duration
	// jitterFn 轮级抖动函数（默认真随机；测试可注入返回 0 以消除时间不确定性）。
	jitterFn   JitterFunc
	stopCh     chan struct{}
	wg         sync.WaitGroup
	cancelFunc context.CancelFunc // cancels the current refresh operation
	mu         sync.Mutex         // protects cancelFunc
}

// defaultInterval 读不到设置时的兜底间隔。
const defaultInterval = 15 * time.Minute

func New(refreshService service.RefreshService, getInterval func() time.Duration) *Scheduler {
	if getInterval == nil {
		getInterval = func() time.Duration { return defaultInterval }
	}
	return &Scheduler{
		refreshService: refreshService,
		getInterval:    getInterval,
		jitterFn:       defaultJitter,
		stopCh:         make(chan struct{}),
	}
}

// SetJitter 注入轮级抖动函数（测试可设成返回 0，避免时间断言抖动）。
func (s *Scheduler) SetJitter(jitter JitterFunc) {
	s.jitterFn = jitter
}

// interval 当前应该用的间隔（<=0 一律当没配置，回兜底）。
func (s *Scheduler) interval() time.Duration {
	d := s.getInterval()
	if d <= 0 {
		return defaultInterval
	}
	return d
}

func (s *Scheduler) Start() {
	s.wg.Add(1)
	go s.run()
	logger.Info("scheduler started", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok", "interval_ms", s.interval().Milliseconds())
}

func (s *Scheduler) Stop() {
	// Cancel any ongoing refresh operation first
	s.mu.Lock()
	if s.cancelFunc != nil {
		s.cancelFunc()
	}
	s.mu.Unlock()

	close(s.stopCh)
	s.wg.Wait()
	logger.Info("scheduler stopped", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok")
}

func (s *Scheduler) run() {
	defer s.wg.Done()

	// Run immediately on start
	s.refresh()

	timer := time.NewTimer(s.interval())
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			s.refresh()
			// 每轮都按最新设置重排下一次 —— 用户把 15 分钟改成 60 分钟，这一轮结束就生效
			// 并叠加一层随机抖动错峰（RoundDelay），避免多实例同刻齐刷。
			next := s.interval()
			delay := RoundDelay(next, s.jitterFn)
			timer.Reset(delay)
			logger.Info("scheduler next round scheduled", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok", "interval_ms", next.Milliseconds(), "delay_ms", delay.Milliseconds())
		case <-s.stopCh:
			return
		}
	}
}

func (s *Scheduler) refresh() {
	// 一轮刷新的整体上限 = 当前间隔（与原来一致：间隔多长就给多久）
	ctx, cancel := context.WithTimeout(context.Background(), s.interval())

	// Store cancel function so Stop() can cancel ongoing refresh
	s.mu.Lock()
	s.cancelFunc = cancel
	s.mu.Unlock()

	defer func() {
		cancel()
		s.mu.Lock()
		s.cancelFunc = nil
		s.mu.Unlock()
	}()

	logger.Info("scheduled feed refresh started", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok")
	if err := s.refreshService.RefreshAllAuto(ctx); err != nil {
		if ctx.Err() != nil {
			logger.Warn("scheduled refresh cancelled", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "cancelled")
			return
		}
		logger.Error("scheduled refresh failed", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "failed", "error", err)
	}
	logger.Info("scheduled feed refresh completed", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok")
}
