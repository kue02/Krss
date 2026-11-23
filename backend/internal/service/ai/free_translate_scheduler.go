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
	// freeChannelNetworkBaseCooldown：网络级失败（连接超时/DNS/连接重置，非 HTTP 状态）的退避基数，
	// 3s→6s→12s… 封顶同 freeChannelMaxCooldown。避免「被墙的通道每次都被优先重试、等满客户端超时」。
	freeChannelNetworkBaseCooldown = 3 * time.Second
	// freeChannelTotalBudget：单次翻译（跨所有通道两轮）的总时间预算，<=0 表示不限。
	// 防止 4 通道 × 单通道超时把一次翻译拖到几十秒。
	freeChannelTotalBudget = 30 * time.Second
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

	if err == nil {
		return
	}
	// 预算/ctx 造成的取消或超时是整体编排的问题，不算该通道的坏健康，别据此冷却。
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return
	}
	now := s.now()

	var httpErr *translateHTTPError
	if !errors.As(err, &httpErr) {
		// 网络级失败（连接超时 / DNS / 连接重置等，非 HTTP 状态码）：同样指数退避冷却，
		// 否则被墙的通道每次都会被优先重试、等到客户端超时，正是要消除的「被一个通道拖垮」。
		st.consecutiveFails++
		st.cooldownUntil = now.Add(backoffCooldown(freeChannelNetworkBaseCooldown, st.consecutiveFails))
		return
	}

	switch {
	case httpErr.StatusCode == http.StatusTooManyRequests || httpErr.StatusCode == http.StatusServiceUnavailable:
		// 429 / 503：连续失败 +1，冷却 = max(Retry-After, base<<min(fails-1,5))，封顶。
		st.consecutiveFails++
		cooldown := backoffCooldown(freeChannelBaseCooldown, st.consecutiveFails)
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

// backoffCooldown 指数退避：base << min(fails-1,5)，封顶 freeChannelMaxCooldown。
func backoffCooldown(base time.Duration, fails int) time.Duration {
	shift := fails - 1
	if shift < 0 {
		shift = 0
	}
	if shift > 5 {
		shift = 5
	}
	d := base << uint(shift)
	if d > freeChannelMaxCooldown {
		d = freeChannelMaxCooldown
	}
	return d
}

// translate 是核心编排：按顺序尝试每个通道，第一轮全失败后对 deferred 的通道做第二轮兜底，
// 仍全失败则返回聚合错误（每个通道的最后错误）。整轮受 freeChannelTotalBudget 总预算约束。
func (s *freeChannelScheduler) translate(ctx context.Context, client *http.Client, channels []string, text, targetLang string) (string, string, error) {
	if client == nil {
		client = http.DefaultClient
	}
	chs := NormalizeFreeTranslateChannels(channels)
	if len(chs) == 0 {
		return "", "", fmt.Errorf("no free translate channel configured")
	}

	// 总预算：<=0 表示不限。防止 4 通道 × 单通道超时把一次翻译拖到几十秒。
	var deadline time.Time
	if freeChannelTotalBudget > 0 {
		deadline = s.now().Add(freeChannelTotalBudget)
	}
	budgetLeft := func() (time.Duration, bool) {
		if deadline.IsZero() {
			return 0, true
		}
		rem := deadline.Sub(s.now())
		return rem, rem > 0
	}

	lastErr := make(map[string]error, len(chs))
	skipReason := make(map[string]string, len(chs))
	deferred := make([]string, 0, len(chs))
	budgetExhausted := false

	// attempt 尝试单个通道一次，返回 (result, ok)。不可用（冷却/并发/限速/预算）返回 false。
	attempt := func(channel string) (string, bool) {
		rem, ok := budgetLeft()
		if !ok {
			budgetExhausted = true
			skipReason[channel] = "skipped (budget)"
			return "", false
		}
		if !s.tryReserve(channel, s.now()) {
			skipReason[channel] = "skipped (rate limited/cooldown)"
			return "", false
		}
		attemptCtx := ctx
		cancel := context.CancelFunc(func() {})
		if !deadline.IsZero() {
			attemptCtx, cancel = context.WithTimeout(ctx, rem)
		}
		translated, err := translateViaChannel(attemptCtx, client, channel, text, targetLang)
		// 预算超时（而非上游/网络自身超时）不算通道坏健康：不 recordFailure，也不记该通道错误。
		budgetHit := err != nil && !deadline.IsZero() && attemptCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil
		cancel()
		s.release(channel)
		if err != nil {
			if budgetHit {
				budgetExhausted = true
				skipReason[channel] = "skipped (budget)"
				return "", false
			}
			lastErr[channel] = err
			s.recordFailure(channel, err)
			return "", false
		}
		s.recordSuccess(channel)
		return translated, true
	}

	// 第一轮：按配置顺序。
	for _, channel := range chs {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		translated, ok := attempt(channel)
		if ok {
			return translated, channel, nil
		}
		if _, tried := lastErr[channel]; !tried {
			// 因冷却/并发/限速/预算没能尝试：进第二轮兜底。
			deferred = append(deferred, channel)
		}
		if budgetExhausted {
			break
		}
	}

	// 第二轮：短暂等待后，只尝试此刻已允许的 deferred 通道。
	if len(deferred) > 0 && !budgetExhausted {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		wait := 200 * time.Millisecond
		if rem, ok := budgetLeft(); !ok {
			budgetExhausted = true
		} else if rem < wait {
			wait = rem
		}
		if !budgetExhausted {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return "", "", ctx.Err()
			}
			for _, channel := range deferred {
				if err := ctx.Err(); err != nil {
					return "", "", err
				}
				translated, ok := attempt(channel)
				if ok {
					return translated, channel, nil
				}
				if budgetExhausted {
					break
				}
			}
		}
	}

	// 全失败：聚合每个通道的最后错误 / 跳过原因。
	parts := make([]string, 0, len(chs))
	for _, channel := range chs {
		if e, ok := lastErr[channel]; ok {
			parts = append(parts, fmt.Sprintf("%s: %v", channel, e))
			continue
		}
		if r, ok := skipReason[channel]; ok {
			parts = append(parts, fmt.Sprintf("%s: %s", channel, r))
			continue
		}
		parts = append(parts, fmt.Sprintf("%s: skipped (rate limited/cooldown)", channel))
	}
	return "", "", fmt.Errorf("all free translate channels failed (%s)", strings.Join(parts, "; "))
}
