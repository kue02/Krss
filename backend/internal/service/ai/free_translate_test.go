package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 测试里把调度器参数放宽，避免限速/冷却让既有用例变慢或互相污染。
// 需要验证冷却/并发的用例会自己再覆盖并把参数恢复。
func TestMain(m *testing.M) {
	freeChannelMaxConcurrency = 100
	freeChannelPerSecond = 1000
	freeChannelPerMinute = 100000
	freeChannelMinGap = 0
	freeChannelBaseCooldown = 0
	freeChannelMaxCooldown = 0
	freeChannelNetworkBaseCooldown = 0
	defaultFreeScheduler.reset()
	os.Exit(m.Run())
}

func TestIsFreeTranslateChannel(t *testing.T) {
	cases := map[string]bool{
		"google": true,
		"youdao": true,
		"":       false,
		"openai": false,
		"bing":   false, // 免费通道现在不通，不做
	}
	for channel, want := range cases {
		if got := IsFreeTranslateChannel(channel); got != want {
			t.Errorf("IsFreeTranslateChannel(%q) = %v, want %v", channel, got, want)
		}
	}
}

func TestTranslateFreeTextGoogle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "Hello world" {
			t.Errorf("q = %q", r.URL.Query().Get("q"))
		}
		if r.URL.Query().Get("tl") != "zh-CN" {
			t.Errorf("tl = %q", r.URL.Query().Get("tl"))
		}
		_, _ = w.Write([]byte(`[[["\u4f60\u597d\u4e16\u754c","Hello world",null,null,10]],null,"en"]`))
	}))
	defer server.Close()

	original := googleTranslateEndpoint
	googleTranslateEndpoint = server.URL
	defer func() { googleTranslateEndpoint = original }()

	got, err := TranslateFreeText(context.Background(), server.Client(), FreeChannelGoogle, " Hello world ", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateFreeText: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
}

func TestTranslateFreeTextYoudao(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("to") != "zh-CHS" {
			t.Errorf("to = %q, want zh-CHS", r.URL.Query().Get("to"))
		}
		_, _ = w.Write([]byte(`{"errorCode":0,"translation":["你好世界"]}`))
	}))
	defer server.Close()

	original := youdaoTranslateEndpoint
	youdaoTranslateEndpoint = server.URL
	defer func() { youdaoTranslateEndpoint = original }()

	got, err := TranslateFreeText(context.Background(), server.Client(), FreeChannelYoudao, "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("TranslateFreeText: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
}

// google 被限流（生产代理 IP 上就是 429 反滥用页）时要回退到有道。
func TestTranslateFreeTextFallsBackToYoudao(t *testing.T) {
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`<html><body>Sorry...</body></html>`))
	}))
	defer googleServer.Close()

	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":0,"translation":["你好世界"]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	got, err := TranslateFreeText(context.Background(), googleServer.Client(), FreeChannelGoogle, "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("google 429 时应回退有道成功，得到错误 %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
}

// 两个通道都失败时，错误里要同时带上两边的失败信息。
func TestTranslateFreeTextFallbackFailureMentionsBoth(t *testing.T) {
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer googleServer.Close()

	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":-1,"translation":[]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	_, err := TranslateFreeText(context.Background(), googleServer.Client(), FreeChannelGoogle, "Hello world", "zh-CN")
	if err == nil {
		t.Fatal("两个通道都失败时应当报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "google") || !strings.Contains(msg, "429") {
		t.Errorf("错误里应包含 google 的失败信息，得到 %q", msg)
	}
	if !strings.Contains(msg, "youdao") || !strings.Contains(msg, "empty translation") {
		t.Errorf("错误里应包含有道的失败信息，得到 %q", msg)
	}
}

func TestTranslateFreeTextErrors(t *testing.T) {
	if _, err := TranslateFreeText(context.Background(), nil, FreeChannelGoogle, "   ", "zh-CN"); err != nil {
		t.Errorf("空文本应返回空且不报错，得到 %v", err)
	}
	if _, err := TranslateFreeText(context.Background(), nil, "unknown", "hi", "zh-CN"); err == nil {
		t.Error("未知通道应当报错")
	}

	// 空译文要报错，不能静默返回空串
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":-1,"translation":[]}`))
	}))
	defer server.Close()
	original := youdaoTranslateEndpoint
	youdaoTranslateEndpoint = server.URL
	defer func() { youdaoTranslateEndpoint = original }()
	if _, err := TranslateFreeText(context.Background(), server.Client(), FreeChannelYoudao, "hi", "zh-CN"); err == nil {
		t.Error("空译文应当报错")
	}
}

func TestNormalizeLangForYoudao(t *testing.T) {
	cases := map[string]string{
		"":      "zh-CHS",
		"zh-CN": "zh-CHS",
		"zh":    "zh-CHS",
		"zh-TW": "zh-CHT",
		"en":    "en",
		"ja":    "ja",
	}
	for in, want := range cases {
		if got := normalizeLangForYoudao(in); got != want {
			t.Errorf("normalizeLangForYoudao(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeFreeTranslateChannels(t *testing.T) {
	got := NormalizeFreeTranslateChannels([]string{" youdao ", "google", "youdao", "", "bing"})
	want := []string{FreeChannelYoudao, FreeChannelGoogle}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if got := NormalizeFreeTranslateChannels(nil); got != nil {
		t.Errorf("nil 输入应返回 nil，得到 %#v", got)
	}
	if got := NormalizeFreeTranslateChannels([]string{"bing"}); got != nil {
		t.Errorf("只有未知通道应返回 nil，得到 %#v", got)
	}
}

func TestEffectiveFreeTranslateChannels(t *testing.T) {
	cases := []struct {
		name       string
		configured []string
		legacy     string
		want       []string
	}{
		{"新键优先", []string{"youdao"}, "google", []string{"youdao"}},
		{"新键为空退回旧键 google（不再扩容）", []string{}, "google", []string{"google"}},
		{"旧键 youdao 只保留自己", nil, "youdao", []string{"youdao"}},
		{"新旧都空走模型", nil, "", nil},
		{"旧键非法返回空", nil, "bing", nil},
		{"新键全非法退回旧键（不再扩容）", []string{"bing"}, "youdao", []string{"youdao"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EffectiveFreeTranslateChannels(tc.configured, tc.legacy)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestDefaultFreeTranslateChannels(t *testing.T) {
	got := DefaultFreeTranslateChannels()
	want := []string{"google", "youdao", "microsoft", "bilibili"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	// 返回的是副本，改动不影响包级列表。
	got[0] = "mutated"
	if FreeTranslateChannels[0] != "google" {
		t.Fatalf("DefaultFreeTranslateChannels 应返回副本")
	}
}

// 轮询顺序：按配置顺序依次尝试，google 失败后才用有道。
func TestTranslateFreeTextChannelsRotatesInOrder(t *testing.T) {
	var order []string
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "google")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer googleServer.Close()
	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "youdao")
		_, _ = w.Write([]byte(`{"errorCode":0,"translation":["你好世界"]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	got, err := TranslateFreeTextChannels(context.Background(), googleServer.Client(), []string{FreeChannelGoogle, FreeChannelYoudao}, "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("轮询应最终成功: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
	if len(order) == 0 || order[0] != "google" {
		t.Errorf("应按配置顺序先试 google，得到顺序 %v", order)
	}
}

// 回退到第二个通道时，必须报告**实际命中**的通道（不能永远是 channels[0]）。
func TestTranslateFreeTextChannelsWithChannelReportsActualChannel(t *testing.T) {
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer googleServer.Close()
	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":0,"translation":["你好世界"]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	got, usedChannel, err := TranslateFreeTextChannelsWithChannel(context.Background(), googleServer.Client(), []string{FreeChannelGoogle, FreeChannelYoudao}, "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("应回退到有道并成功: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
	if usedChannel != FreeChannelYoudao {
		t.Errorf("应报告实际命中的 youdao，得到 %q", usedChannel)
	}
}

// 全部通道失败时，错误里要列出每一个通道。
func TestTranslateFreeTextChannelsAllFail(t *testing.T) {
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer googleServer.Close()
	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":-1,"translation":[]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	_, err := TranslateFreeTextChannels(context.Background(), googleServer.Client(), []string{FreeChannelGoogle, FreeChannelYoudao}, "hi", "zh-CN")
	if err == nil {
		t.Fatal("全部失败时应当报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "all free translate channels failed") || !strings.Contains(msg, "google") || !strings.Contains(msg, "youdao") {
		t.Errorf("错误应汇总每个通道，得到 %q", msg)
	}
}

func TestTranslateFreeTextChannelsEmptyConfig(t *testing.T) {
	if _, err := TranslateFreeTextChannels(context.Background(), nil, nil, "hi", "zh-CN"); err == nil {
		t.Error("没有可用通道时应当报错")
	}
	if _, err := TranslateFreeTextChannels(context.Background(), nil, []string{FreeChannelGoogle}, "   ", "zh-CN"); err != nil {
		t.Errorf("空文本应返回空且不报错，得到 %v", err)
	}
}

// ---- 微软翻译 ----

func TestTranslateViaMicrosoft(t *testing.T) {
	var gotBody []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Query().Get("to") != "zh-Hans" {
			t.Errorf("to = %q, want zh-Hans", r.URL.Query().Get("to"))
		}
		if ct := r.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("content-type = %q", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_, _ = w.Write([]byte(`[{"translations":[{"text":"你好 &amp; 世界"}]}]`))
	}))
	defer server.Close()

	original := microsoftTranslateEndpoint
	microsoftTranslateEndpoint = server.URL
	defer func() { microsoftTranslateEndpoint = original }()

	got, err := translateViaMicrosoft(context.Background(), server.Client(), "Hello & world", "zh-CN")
	if err != nil {
		t.Fatalf("translateViaMicrosoft: %v", err)
	}
	if got != "你好 & 世界" {
		t.Errorf("got %q, want 你好 & 世界", got)
	}
	// 正文必须以 HTML 转义后的形式发出（端点会做标签对齐）。
	if len(gotBody) != 1 || gotBody[0] != "Hello &amp; world" {
		t.Errorf("body = %v, want [Hello &amp; world]", gotBody)
	}
}

func TestNormalizeLangForMicrosoft(t *testing.T) {
	cases := map[string]string{
		"zh-CN": "zh-Hans",
		"zh-TW": "zh-Hant",
		"zh":    "zh-Hans",
		"sr":    "sr-Cyrl",
		"en":    "en",
		"ja":    "ja",
	}
	for in, want := range cases {
		if got := normalizeLangForMicrosoft(in); got != want {
			t.Errorf("normalizeLangForMicrosoft(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---- B站翻译 ----

func TestTranslateViaBilibili(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if req.Model != "Index-Translate-35B-A3B" {
			t.Errorf("model = %q", req.Model)
		}
		if len(req.Messages) != 1 || !strings.Contains(req.Messages[0].Content, "Hello world") ||
			!strings.Contains(req.Messages[0].Content, "请将以下文本翻译为简体中文") {
			t.Errorf("prompt 不正确: %+v", req.Messages)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"你好世界"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	original := bilibiliTranslateEndpoint
	bilibiliTranslateEndpoint = server.URL
	defer func() { bilibiliTranslateEndpoint = original }()

	got, err := translateViaBilibili(context.Background(), server.Client(), "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("translateViaBilibili: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
}

func TestTranslateViaBilibiliStripsThink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"<think>reasoning here</think>你好世界"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	original := bilibiliTranslateEndpoint
	bilibiliTranslateEndpoint = server.URL
	defer func() { bilibiliTranslateEndpoint = original }()

	got, err := translateViaBilibili(context.Background(), server.Client(), "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("translateViaBilibili: %v", err)
	}
	if got != "你好世界" {
		t.Errorf("got %q, want 你好世界", got)
	}
}

func TestTranslateViaBilibiliLengthIncomplete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"半截译文"},"finish_reason":"length"}]}`))
	}))
	defer server.Close()

	original := bilibiliTranslateEndpoint
	bilibiliTranslateEndpoint = server.URL
	defer func() { bilibiliTranslateEndpoint = original }()

	if _, err := translateViaBilibili(context.Background(), server.Client(), "Hello world", "zh-CN"); err == nil {
		t.Fatal("finish_reason=length 应报翻译结果不完整")
	} else if !strings.Contains(err.Error(), "翻译结果不完整") {
		t.Errorf("error = %q, want 翻译结果不完整", err.Error())
	}
}

// ---- 调度器 ----

// 429 + Retry-After：第一个通道进冷却，本轮直接跳到第二个成功；下一次调用也不再试冷却中的通道。
func TestSchedulerSkipsCoolingChannelAfter429(t *testing.T) {
	restore := setFastSchedulerParams()
	defer restore()
	defaultFreeScheduler.reset()

	var googleHits int32
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&googleHits, 1)
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer googleServer.Close()
	youdaoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":0,"translation":["你好世界"]}`))
	}))
	defer youdaoServer.Close()

	originalGoogle, originalYoudao := googleTranslateEndpoint, youdaoTranslateEndpoint
	googleTranslateEndpoint = googleServer.URL
	youdaoTranslateEndpoint = youdaoServer.URL
	defer func() {
		googleTranslateEndpoint = originalGoogle
		youdaoTranslateEndpoint = originalYoudao
	}()

	got, used, err := TranslateFreeTextChannelsWithChannel(context.Background(), googleServer.Client(), []string{FreeChannelGoogle, FreeChannelYoudao}, "Hello world", "zh-CN")
	if err != nil {
		t.Fatalf("应回退有道成功: %v", err)
	}
	if used != FreeChannelYoudao || got != "你好世界" {
		t.Fatalf("used=%q got=%q, want youdao/你好世界", used, got)
	}
	if atomic.LoadInt32(&googleHits) != 1 {
		t.Fatalf("首轮应只打一次 google，得到 %d", googleHits)
	}

	// 冷却中：第二次调用不应再打 google。
	if _, used2, err2 := TranslateFreeTextChannelsWithChannel(context.Background(), googleServer.Client(), []string{FreeChannelGoogle, FreeChannelYoudao}, "Hello world", "zh-CN"); err2 != nil || used2 != FreeChannelYoudao {
		t.Fatalf("第二次应仍用 youdao，得到 used=%q err=%v", used2, err2)
	}
	if atomic.LoadInt32(&googleHits) != 1 {
		t.Errorf("冷却中不应再请求 google，得到 %d 次", googleHits)
	}
}

// 429/503 连续失败时冷却时长按指数递增（2s → 4s → 8s）。
func TestSchedulerCooldownEscalates(t *testing.T) {
	oldBase, oldMax := freeChannelBaseCooldown, freeChannelMaxCooldown
	freeChannelBaseCooldown = 2 * time.Second
	freeChannelMaxCooldown = 5 * time.Minute
	defer func() { freeChannelBaseCooldown, freeChannelMaxCooldown = oldBase, oldMax }()

	fixed := time.Unix(1_700_000_000, 0)
	s := newFreeChannelScheduler()
	s.now = func() time.Time { return fixed }

	step := func() time.Duration {
		s.recordFailure("google", &translateHTTPError{StatusCode: http.StatusTooManyRequests})
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.states["google"].cooldownUntil.Sub(fixed)
	}

	if d := step(); d != 2*time.Second {
		t.Errorf("第 1 次失败冷却 = %v, want 2s", d)
	}
	// 推进时间越过冷却，否则时长为“剩余”语义仍以 now 为基准计算，这里 now 固定所以直接看累加值。
	if d := step(); d != 4*time.Second {
		t.Errorf("第 2 次失败冷却 = %v, want 4s", d)
	}
	if d := step(); d != 8*time.Second {
		t.Errorf("第 3 次失败冷却 = %v, want 8s", d)
	}
}

// 真实 http.Client 超时（父 ctx 未取消）也要冷却；父 ctx 被调用方取消则不冷却。
func TestSchedulerCoolsOnNetworkError(t *testing.T) {
	oldNet, oldMax := freeChannelNetworkBaseCooldown, freeChannelMaxCooldown
	freeChannelNetworkBaseCooldown = 3 * time.Second
	freeChannelMaxCooldown = 5 * time.Minute
	defer func() { freeChannelNetworkBaseCooldown, freeChannelMaxCooldown = oldNet, oldMax }()

	var hits int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`[{"translations":[{"text":"你好"}]}]`))
	}))
	defer slow.Close()
	orig := microsoftTranslateEndpoint
	microsoftTranslateEndpoint = slow.URL
	defer func() { microsoftTranslateEndpoint = orig }()

	// 真实 http.Client 超时：错误 errors.Is(..., context.DeadlineExceeded) 为 true，但父 ctx 未取消，
	// 必须被当成网络级失败冷却（不能因为像 ctx 超时就被跳过）。
	s := newFreeChannelScheduler()
	timedClient := &http.Client{Timeout: 40 * time.Millisecond}
	if _, _, err := s.translate(context.Background(), timedClient, []string{FreeChannelMicrosoft}, "hi", "zh-CN"); err == nil {
		t.Fatal("真实超时应当报错")
	}
	s.mu.Lock()
	cool := s.states[FreeChannelMicrosoft].cooldownUntil
	fails := s.states[FreeChannelMicrosoft].consecutiveFails
	s.mu.Unlock()
	if cool.IsZero() || fails == 0 {
		t.Fatalf("真实 http 超时应冷却并计连续失败，得到 cooldown=%v fails=%d", cool, fails)
	}

	// 冷却中的通道下一次应被跳过，不再打到端点。
	before := atomic.LoadInt32(&hits)
	if _, _, err := s.translate(context.Background(), timedClient, []string{FreeChannelMicrosoft}, "hi", "zh-CN"); err == nil {
		t.Fatal("冷却中仍应报错（无可用通道）")
	}
	if after := atomic.LoadInt32(&hits); after != before {
		t.Fatalf("冷却中的通道不应再被请求，hits %d -> %d", before, after)
	}

	// 父 ctx 被调用方取消/超时：不计失败、不冷却（这不是通道的错）。
	s2 := newFreeChannelScheduler()
	ctx2, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	_, _, _ = s2.translate(ctx2, slow.Client(), []string{FreeChannelMicrosoft}, "hi", "zh-CN")
	s2.mu.Lock()
	cool2 := s2.states[FreeChannelMicrosoft].cooldownUntil
	fails2 := s2.states[FreeChannelMicrosoft].consecutiveFails
	s2.mu.Unlock()
	if !cool2.IsZero() || fails2 != 0 {
		t.Fatalf("父 ctx 取消不应冷却/计连续失败，得到 cooldown=%v fails=%d", cool2, fails2)
	}
}

// 单次翻译总预算：慢通道被预算截断，后续通道标注 skipped (budget)，且不冷却该通道。
func TestSchedulerRespectsTotalBudget(t *testing.T) {
	oldBudget, oldNet, oldMax := freeChannelTotalBudget, freeChannelNetworkBaseCooldown, freeChannelMaxCooldown
	freeChannelTotalBudget = 80 * time.Millisecond
	freeChannelNetworkBaseCooldown = 3 * time.Second
	freeChannelMaxCooldown = 5 * time.Minute
	defer func() {
		freeChannelTotalBudget, freeChannelNetworkBaseCooldown, freeChannelMaxCooldown = oldBudget, oldNet, oldMax
	}()

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`[{"translations":[{"text":"你好"}]}]`))
	}))
	defer slow.Close()
	original := microsoftTranslateEndpoint
	microsoftTranslateEndpoint = slow.URL
	defer func() { microsoftTranslateEndpoint = original }()

	s := newFreeChannelScheduler()
	_, _, err := s.translate(context.Background(), slow.Client(), []string{FreeChannelMicrosoft, FreeChannelBilibili}, "hi", "zh-CN")
	if err == nil || !strings.Contains(err.Error(), "skipped (budget)") {
		t.Fatalf("预算耗尽应报 skipped (budget)，得到 %v", err)
	}
	s.mu.Lock()
	fails := s.states[FreeChannelMicrosoft].consecutiveFails
	s.mu.Unlock()
	if fails != 0 {
		t.Fatalf("预算超时不应计连续失败，得到 %d", fails)
	}
}

// 并发上限：同一通道同时最多 freeChannelMaxConcurrency 个在飞请求。
func TestSchedulerRespectsConcurrencyCap(t *testing.T) {
	oldConc, oldPS, oldPM, oldGap := freeChannelMaxConcurrency, freeChannelPerSecond, freeChannelPerMinute, freeChannelMinGap
	freeChannelMaxConcurrency = 2
	freeChannelPerSecond = 100000
	freeChannelPerMinute = 1000000
	freeChannelMinGap = 0
	defer func() {
		freeChannelMaxConcurrency, freeChannelPerSecond, freeChannelPerMinute, freeChannelMinGap = oldConc, oldPS, oldPM, oldGap
	}()

	var inflight, maxInflight int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := atomic.AddInt32(&inflight, 1)
		for {
			prev := atomic.LoadInt32(&maxInflight)
			if cur <= prev || atomic.CompareAndSwapInt32(&maxInflight, prev, cur) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		_, _ = w.Write([]byte(`[{"translations":[{"text":"你好"}]}]`))
	}))
	defer server.Close()

	original := microsoftTranslateEndpoint
	microsoftTranslateEndpoint = server.URL
	defer func() { microsoftTranslateEndpoint = original }()

	s := newFreeChannelScheduler()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = s.translate(context.Background(), server.Client(), []string{FreeChannelMicrosoft}, "hi", "zh-CN")
		}()
	}
	wg.Wait()

	if maxInflight > int32(freeChannelMaxConcurrency) {
		t.Errorf("最大并发 = %d, 超过上限 %d", maxInflight, freeChannelMaxConcurrency)
	}
}

// setFastSchedulerParams 把调度器参数设为「不限速但保留冷却」的组合，返回恢复函数。
func setFastSchedulerParams() func() {
	oldConc, oldPS, oldPM, oldGap := freeChannelMaxConcurrency, freeChannelPerSecond, freeChannelPerMinute, freeChannelMinGap
	oldBase, oldMax := freeChannelBaseCooldown, freeChannelMaxCooldown
	freeChannelMaxConcurrency = 100
	freeChannelPerSecond = 1000
	freeChannelPerMinute = 100000
	freeChannelMinGap = 0
	freeChannelBaseCooldown = 2 * time.Second
	freeChannelMaxCooldown = 5 * time.Minute
	return func() {
		freeChannelMaxConcurrency, freeChannelPerSecond, freeChannelPerMinute, freeChannelMinGap = oldConc, oldPS, oldPM, oldGap
		freeChannelBaseCooldown, freeChannelMaxCooldown = oldBase, oldMax
	}
}
