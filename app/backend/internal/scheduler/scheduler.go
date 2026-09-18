package scheduler

import (
	"context"
	"sync"
	"time"

	"gist/backend/internal/service"
	"gist/backend/pkg/logger"
)

type Scheduler struct {
	refreshService service.RefreshService
	// getInterval 每轮重新读一次间隔（用户 11-20：拉取频率可配置，改完下一轮生效、不用重启）
	getInterval func() time.Duration
	stopCh      chan struct{}
	wg          sync.WaitGroup
	cancelFunc  context.CancelFunc // cancels the current refresh operation
	mu          sync.Mutex         // protects cancelFunc
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
		stopCh:         make(chan struct{}),
	}
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
			next := s.interval()
			timer.Reset(next)
			logger.Info("scheduler next round scheduled", "module", "scheduler", "action", "refresh", "resource", "feed", "result", "ok", "interval_ms", next.Milliseconds())
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
