package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
		{"新键为空退回旧键 google", []string{}, "google", []string{"google", "youdao"}},
		{"旧键 youdao 排最前", nil, "youdao", []string{"youdao", "google"}},
		{"新旧都空走模型", nil, "", nil},
		{"旧键非法返回空", nil, "bing", nil},
		{"新键全非法退回旧键", []string{"bing"}, "youdao", []string{"youdao", "google"}},
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
