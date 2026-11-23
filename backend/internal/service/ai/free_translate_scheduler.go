package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 免费通道调度器：把原来的「顺序遍历 + 每通道盲重试 2 次」换成
// 并发桶 + 每秒/每分钟限速 + 429/503 冷却（读 Retry-After）+ 健康度记忆（连续失败指数退避）。
//
// 设计目标：
//   - 尊重用户配置的通道顺序（顺序即轮询顺序），但遇到冷却中/超限的通道就跳到下一个、
//     放到后面兜底（第二轮），不再「死磕第一个」。
//   - 每通道在飞请求有上限（freeChannelMaxConcurrency），避免把免费端点打崩（有道 411）。
//   - 429/503 记连续失败并冷却，冷却时长取 Retry-After 与指数退避的较大者，封顶 5 分钟。
//   - 状态按通道记忆并随进程存活（defaultFreeScheduler），下次请求直接跳过还在冷却里的通道。

// 包级可调参数（var，便于测试覆盖）。
var (
	freeChannelMaxConcurrency = 3
	freeChannelPerSecond      = 8
	freeChannelPerMinute      = 200
	freeChannelMinGap         = 120 * time.Millisecond
	freeChannelBaseCooldown   = 2 * time.Second
	freeChannelMaxCooldown    = 5 * time.Minute
)

// freeChannelScheduler 是一个进程内的免费通道调度器。
type freeChannelScheduler struct {
	mu     sync.Mutex
	states map[string]*freeChannelState
	now    func() time.Time
}

// freeChannelState 每个通道独立的运行态。
type freeChannelState struct {
	// sem 是每通道在飞并发上限（容量 = freeChannelMaxConcurrency）。
	sem chan struct{}

	cooldownUntil    time.Time
	consecutiveFails int

	successes int64
	failures  int64

	secWindowStart time.Time
	secCount       int
	minWindowStart time.Time
	minCount       int

	lastUsed time.Time
}

func newFreeChannelScheduler() *freeChannelScheduler {
	return &freeChannelScheduler{
		states: make(map[string]*freeChannelState),
		now:    time.Now,
	}
}

// defaultFreeScheduler 是主路径用的包级单例：健康度与冷却跨请求累积。
var defaultFreeScheduler = newFreeChannelScheduler()

// reset 清空所有通道状态（测试用）。
func (s *freeChannelScheduler) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = make(map[string]*freeChannelState)
}

// stateFor 取（必要时创建）通道状态。调用方必须已持有 s.mu。
func (s *freeChannelScheduler) stateFor(channel string) *freeChannelState {
	st, ok := s.states[channel]
	if !ok {
		st = &freeChannelState{sem: make(chan struct{}, freeChannelMaxConcurrency)}
		s.states[channel] = st
	}
	return st
}

// tryReserve 在锁内判断通道此刻是否可用于一次尝试；可用则占用并发槽并记账。
// 不可用（冷却中 / 并发已满 / 超每秒或每分钟预算 / 距上次使用太近）返回 false，
// 由调用方把通道放进 deferred 第二轮兜底。
func (s *freeChannelScheduler) tryReserve(channel string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	st := s.stateFor(channel)
	if now.Before(st.cooldownUntil) {
		return false
	}
	// 每秒窗口
	if st.secWindowStart.IsZero() || now.Sub(st.secWindowStart) >= time.Second {
		st.secWindowStart = now
		st.secCount = 0
	}
	if st.secCount >= freeChannelPerSecond {
		return false
	}
	// 每分钟窗口
	if st.minWindowStart.IsZero() || now.Sub(st.minWindowStart) >= time.Minute {
		st.minWindowStart = now
		st.minCount = 0
	}
	if st.minCount >= freeChannelPerMinute {
		return false
	}
	// 同通道最小间隔
	if !st.lastUsed.IsZero() && now.Sub(st.lastUsed) < freeChannelMinGap {
		return false
	}
	// 并发槽（非阻塞）
	select {
	case st.sem <- struct{}{}:
	default:
		return false
	}
	st.secCount++
	st.minCount++
	st.lastUsed = now
	return true
}

// release 释放一次尝试占用的并发槽。
func (s *freeChannelScheduler) release(channel string) {
	s.mu.Lock()
	st := s.stateFor(channel)
	select {
	case <-st.sem:
	default:
	}
	s.mu.Unlock()
}

// recordSuccess 成功：清连续失败计数与冷却。
func (s *freeChannelScheduler) recordSuccess(channel string) {
	s.mu.Lock()
	st := s.stateFor(channel)
	st.successes++
	st.consecutiveFails = 0
	st.cooldownUntil = time.Time{}
	s.mu.Unlock()
}

// recordFailure 失败：按错误类型决定是否冷却、冷却多久。
func (s *freeChannelScheduler) recordFailure(channel string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	st := s.stateFor(channel)
	st.failures++

	var httpErr *translateHTTPError
	if !errors.As(err, &httpErr) {
		return
	}
	now := s.now()

	switch {
	case httpErr.StatusCode == http.StatusTooManyRequests || httpErr.StatusCode == http.StatusServiceUnavailable:
		// 429 / 503：连续失败 +1，冷却 = max(Retry-After, base<<min(fails-1,5))，封顶。
		st.consecutiveFails++
		shift := st.consecutiveFails - 1
		if shift > 5 {
			shift = 5
		}
		if shift < 0 {
			shift = 0
		}
		backoff := freeChannelBaseCooldown << uint(shift)
		cooldown := backoff
		if httpErr.RetryAfter > cooldown {
			cooldown = httpErr.RetryAfter
		}
		if cooldown > freeChannelMaxCooldown {
			cooldown = freeChannelMaxCooldown
		}
		st.cooldownUntil = now.Add(cooldown)
	case httpErr.StatusCode >= 500:
		// 其它 5xx：短冷却。
		st.cooldownUntil = now.Add(freeChannelBaseCooldown)
	default:
		// 其它（4xx / 解析失败等）：不冷却，仅记失败。
	}
}

// translate 是核心编排：按顺序尝试每个通道，第一轮全失败后对 deferred 的通道做第二轮兜底，
// 仍全失败则返回聚合错误（每个通道的最后错误）。
func (s *freeChannelScheduler) translate(ctx context.Context, client *http.Client, channels []string, text, targetLang string) (string, string, error) {
	if client == nil {
		client = http.DefaultClient
	}
	chs := NormalizeFreeTranslateChannels(channels)
	if len(chs) == 0 {
		return "", "", fmt.Errorf("no free translate channel configured")
	}

	lastErr := make(map[string]error, len(chs))
	deferred := make([]string, 0, len(chs))

	// attempt 尝试单个通道一次。返回 (result, channel, ok, ctxErr)。
	attempt := func(channel string) (string, bool, error) {
		if !s.tryReserve(channel, s.now()) {
			return "", false, nil // 不可用：留给调用方 deferred
		}
		translated, err := translateViaChannel(ctx, client, channel, text, targetLang)
		s.release(channel)
		if err != nil {
			lastErr[channel] = err
			s.recordFailure(channel, err)
			return "", false, nil
		}
		s.recordSuccess(channel)
		return translated, true, nil
	}

	// 第一轮：按配置顺序。
	for _, channel := range chs {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		translated, ok, _ := attempt(channel)
		if ok {
			return translated, channel, nil
		}
		if _, tried := lastErr[channel]; !tried {
			// 因冷却/并发/限速没能尝试：进第二轮兜底。
			deferred = append(deferred, channel)
		}
	}

	// 第二轮：短暂等待后，只尝试此刻已允许的 deferred 通道。
	if len(deferred) > 0 {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
		for _, channel := range deferred {
			if err := ctx.Err(); err != nil {
				return "", "", err
			}
			translated, ok, _ := attempt(channel)
			if ok {
				return translated, channel, nil
			}
		}
	}

	// 全失败：聚合每个通道的最后错误。
	parts := make([]string, 0, len(chs))
	for _, channel := range chs {
		if e, ok := lastErr[channel]; ok {
			parts = append(parts, fmt.Sprintf("%s: %v", channel, e))
		} else {
			parts = append(parts, fmt.Sprintf("%s: skipped (rate limited/cooldown)", channel))
		}
	}
	return "", "", fmt.Errorf("all free translate channels failed (%s)", strings.Join(parts, "; "))
}
