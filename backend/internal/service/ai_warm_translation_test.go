package service_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/internal/service/ai"
)

/**
 * 50-1：预载改成「调 warm 落缓存、立刻返回」，不再各占一条 SSE 长连接。
 *
 * 判定实验（隔离栈实测）证明连接被占满有多致命：
 *   同时开着的翻译流 0/1/2/3/4 → 设置接口 9/9/18/9/18 ms
 *   开到 6 条 → **45,630 ms**（浏览器同源 HTTP/1.1 只给 6 条并发）
 *
 * 这组用例守两件事：
 *   ① 已经翻好的条目不再起后台任务（直接说 cached）
 *   ② 同一条目连续 warm 只起一个后台任务（single-flight）——
 *      否则预载滚动路过就重复翻，每一次都是真金白银的模型调用
 */

// blockingAIProvider 起一个「会慢一点」的假模型：用来观察 warm 是否重复起任务。
// 返回计数器指针，测试里断言上游只被打了 1 次。
func blockingAIProvider(t *testing.T, delay time.Duration) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"<p>translated</p>"},"finish_reason":"stop"}]}`)
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func newWarmTestService(t *testing.T, baseURL string, translationRepo *translationRepoStub) service.AIService {
	t.Helper()
	settings := newSettingsRepoStub()
	settings.data[service.KeyAISummaryLanguage] = "zh-CN"
	settings.data[service.KeyAIProvider] = "compatible"
	settings.data[service.KeyAIModel] = "test-model"
	settings.data[service.KeyAIAPIKey] = "test-key"
	settings.data[service.KeyAIBaseURL] = baseURL
	return service.NewAIService(&summaryRepoStub{}, translationRepo, &listTranslationRepoStub{}, settings, ai.NewRateLimiter(1000))
}

func TestWarmTranslation_SkipsWhenAlreadyCached(t *testing.T) {
	server, calls := blockingAIProvider(t, 10*time.Millisecond)

	repo := &translationRepoStub{getResult: &model.AITranslation{Content: "<p>已有译文</p>"}}
	svc := newWarmTestService(t, server.URL, repo)

	alreadyCached, err := svc.WarmTranslation(context.Background(), 42, "<p>Hello</p>", "t", false)
	require.NoError(t, err)
	require.True(t, alreadyCached, "已缓存的条目应当直接返回 cached")
	time.Sleep(120 * time.Millisecond)
	require.Equal(t, int32(0), atomic.LoadInt32(calls), "已缓存时不该起任何后台翻译")
}

func TestWarmTranslation_SingleFlight(t *testing.T) {
	// 让假模型慢一点，好在它跑的时候连续发第二次 warm
	server, calls := blockingAIProvider(t, 400*time.Millisecond)

	repo := &translationRepoStub{} // Get 返回 nil ⇒ 没缓存
	svc := newWarmTestService(t, server.URL, repo)

	alreadyCached, err := svc.WarmTranslation(context.Background(), 43, "<p>Hello world</p>", "t", false)
	require.NoError(t, err)
	require.False(t, alreadyCached, "第一次应当起后台任务")

	// 立刻再来两次：这俩必须被 single-flight 吞掉，不能各起一个任务
	_, err = svc.WarmTranslation(context.Background(), 43, "<p>Hello world</p>", "t", false)
	require.NoError(t, err)
	_, err = svc.WarmTranslation(context.Background(), 43, "<p>Hello world</p>", "t", false)
	require.NoError(t, err)

	time.Sleep(1200 * time.Millisecond)
	require.Equal(t, int32(1), atomic.LoadInt32(calls), "同一条目同时只该有一个后台翻译任务")
}

func TestWarmTranslation_ReturnsImmediately(t *testing.T) {
	// 假模型故意慢：warm 必须「发起即返回」，不能等它跑完（否则又变成长连接）
	server, _ := blockingAIProvider(t, 800*time.Millisecond)
	svc := newWarmTestService(t, server.URL, &translationRepoStub{})

	start := time.Now()
	_, err := svc.WarmTranslation(context.Background(), 44, "<p>Hello world</p>", "t", false)
	elapsed := time.Since(start)
	require.NoError(t, err)
	require.Less(t, elapsed, 200*time.Millisecond, "warm 必须立刻返回，实测 %v", elapsed)
}
