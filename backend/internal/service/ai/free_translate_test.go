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
