package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 免 key 的翻译通道。
//
// 这两个通道不需要任何注册/密钥，直接 GET 就有结果，适合「只想翻译、不想配 API」的场景。
// （Bing 的免费通道这条没做：edge.microsoft.com/translate/auth 现在返回 404，
// www.bing.com/ttranslatev3 需要先从页面刮 IG/IID 还要过 captcha，实测拿到的是
// {"ShowCaptcha":false} 的空结果，属于随时会烂的路子，不值得塞进设置里。）
const (
	FreeChannelGoogle = "google"
	FreeChannelYoudao = "youdao"
)

// 端点抽成变量，测试里可以换成 httptest 服务器。
var (
	googleTranslateEndpoint = "https://translate.googleapis.com/translate_a/single"
	youdaoTranslateEndpoint = "https://aidemo.youdao.com/trans"
)

// FreeTranslateChannels 所有支持的免 key 通道，数组顺序即默认轮询顺序。
// 设置页里用户可自行勾选、排序；实际轮询列表见 EffectiveFreeTranslateChannels。
var FreeTranslateChannels = []string{FreeChannelGoogle, FreeChannelYoudao}

// IsFreeTranslateChannel 判断某个通道名是不是免 key 通道。
func IsFreeTranslateChannel(channel string) bool {
	for _, c := range FreeTranslateChannels {
		if channel == c {
			return true
		}
	}
	return false
}

// NormalizeFreeTranslateChannels 过滤掉未知/空通道并去重，保持原有顺序。
func NormalizeFreeTranslateChannels(channels []string) []string {
	if len(channels) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(channels))
	out := make([]string, 0, len(channels))
	for _, c := range channels {
		c = strings.TrimSpace(c)
		if !IsFreeTranslateChannel(c) {
			continue
		}
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// EffectiveFreeTranslateChannels 计算实际要轮询的通道列表：
//   - 新键（ai.translate_channels，数组）非空 → 用它（已归一化，顺序即轮询顺序）；
//   - 否则退回旧键（ai.translate_channel，单个通道）：把它排在最前、其余可用通道跟在后面
//     （老用户只配了 google / youdao 的，升级后自动获得「轮询 + 回退」能力）；
//   - 旧键也为空 → 返回空（表示不走免费通道，翻译直接走配置的模型）。
func EffectiveFreeTranslateChannels(configured []string, legacy string) []string {
	if normalized := NormalizeFreeTranslateChannels(configured); len(normalized) > 0 {
		return normalized
	}
	legacy = strings.TrimSpace(legacy)
	if !IsFreeTranslateChannel(legacy) {
		return nil
	}
	out := []string{legacy}
	for _, c := range FreeTranslateChannels {
		if c != legacy {
			out = append(out, c)
		}
	}
	return out
}

// TranslateFreeText 用单个免 key 通道翻译一段纯文本（保留旧语义：google 失败会自动回退
// 有道，有道作为主通道时不做反向回退）。新代码请优先用 TranslateFreeTextChannels。
func TranslateFreeText(ctx context.Context, client *http.Client, channel, text, targetLang string) (string, error) {
	return TranslateFreeTextChannels(ctx, client, channelRotation(channel), text, targetLang)
}

// channelRotation 单个通道对应的轮询列表（兼容旧调用）。
func channelRotation(channel string) []string {
	switch channel {
	case FreeChannelGoogle:
		return []string{FreeChannelGoogle, FreeChannelYoudao}
	case FreeChannelYoudao:
		return []string{FreeChannelYoudao}
	default:
		return []string{channel} // 未知通道：交给下游统一报错
	}
}

// TranslateFreeTextChannels 按给定顺序依次尝试免 key 通道，第一个成功即返回；
// 全部失败时返回汇总错误（列出每个通道的失败原因）。空文本返回 ("", nil)。
func TranslateFreeTextChannels(ctx context.Context, client *http.Client, channels []string, text, targetLang string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", nil
	}
	if client == nil {
		client = http.DefaultClient
	}
	normalized := NormalizeFreeTranslateChannels(channels)
	if len(normalized) == 0 {
		return "", fmt.Errorf("no free translate channel configured")
	}

	failures := make([]string, 0, len(normalized))
	for _, channel := range normalized {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		translated, err := translateWithRetry(ctx, client, channel, text, targetLang)
		if err == nil {
			return translated, nil
		}
		failures = append(failures, fmt.Sprintf("%s: %v", channel, err))
	}
	return "", fmt.Errorf("all free translate channels failed (%s)", strings.Join(failures, "; "))
}

// translateWithRetry 对单个通道最多试两次：免费通道偶发 5xx / 空结果，重试一次再说失败。
func translateWithRetry(ctx context.Context, client *http.Client, channel, text, targetLang string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(900 * time.Millisecond):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		translated, err := translateViaChannel(ctx, client, channel, text, targetLang)
		if err == nil {
			return translated, nil
		}
		lastErr = err
	}
	return "", lastErr
}

// translateViaChannel 按通道分发到底层实现。
func translateViaChannel(ctx context.Context, client *http.Client, channel, text, targetLang string) (string, error) {
	switch channel {
	case FreeChannelGoogle:
		return translateViaGoogle(ctx, client, text, targetLang)
	case FreeChannelYoudao:
		return translateViaYoudao(ctx, client, text, targetLang)
	default:
		return "", fmt.Errorf("unknown free translate channel: %s", channel)
	}
}

// google：translate.googleapis.com 的 gtx 端点，返回嵌套数组，[0][*][0] 是译文片段。
func translateViaGoogle(ctx context.Context, client *http.Client, text, targetLang string) (string, error) {
	endpoint := googleTranslateEndpoint + "?client=gtx&dt=t&sl=auto&tl=" +
		url.QueryEscape(normalizeLangForGoogle(targetLang)) + "&q=" + url.QueryEscape(text)

	body, err := httpGetJSON(ctx, client, endpoint, map[string]string{
		"Accept":          "application/json",
		"Accept-Language": "en-US,en;q=0.9",
	})
	if err != nil {
		return "", err
	}

	var payload []json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("google translate decode: %w", err)
	}
	if len(payload) == 0 {
		return "", fmt.Errorf("google translate: empty response")
	}

	var segments [][]json.RawMessage
	if err := json.Unmarshal(payload[0], &segments); err != nil {
		return "", fmt.Errorf("google translate segments: %w", err)
	}

	var out strings.Builder
	for _, segment := range segments {
		if len(segment) == 0 {
			continue
		}
		var piece string
		if err := json.Unmarshal(segment[0], &piece); err != nil {
			continue
		}
		out.WriteString(piece)
	}
	translated := strings.TrimSpace(out.String())
	if translated == "" {
		return "", fmt.Errorf("google translate: no text in response")
	}
	return translated, nil
}

// youdao：aidemo 的 trans 端点（fanyi.youdao.com/translate 那个老接口已经不给数据了）。
func translateViaYoudao(ctx context.Context, client *http.Client, text, targetLang string) (string, error) {
	endpoint := youdaoTranslateEndpoint + "?from=Auto&to=" +
		url.QueryEscape(normalizeLangForYoudao(targetLang)) + "&q=" + url.QueryEscape(text)

	body, err := httpGetJSON(ctx, client, endpoint, map[string]string{
		"Accept":     "application/json",
		"Referer":    "https://fanyi.youdao.com/",
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	})
	if err != nil {
		return "", err
	}

	var payload struct {
		Translation []string `json:"translation"`
		// 有道这个字段有时是数字、有时是字符串（"0"），别写死类型
		ErrorCode any `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("youdao translate decode: %w", err)
	}
	translated := strings.TrimSpace(strings.Join(payload.Translation, ""))
	if translated == "" {
		return "", fmt.Errorf("youdao translate: empty translation (errorCode=%v)", payload.ErrorCode)
	}
	return translated, nil
}

func httpGetJSON(ctx context.Context, client *http.Client, endpoint string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build translate request: %w", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("translate request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("translate request status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read translate response: %w", err)
	}
	return body, nil
}

// google 要 zh-CN / en 这样的写法
func normalizeLangForGoogle(lang string) string {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return "zh-CN"
	}
	return lang
}

// 有道用 zh-CHS / zh-CHT / en 这类写法
func normalizeLangForYoudao(lang string) string {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "", "zh", "zh-cn", "zh-hans", "zh-chs", "chinese":
		return "zh-CHS"
	case "zh-tw", "zh-hk", "zh-hant", "zh-cht":
		return "zh-CHT"
	case "en", "en-us", "en-gb":
		return "en"
	default:
		return lang
	}
}
