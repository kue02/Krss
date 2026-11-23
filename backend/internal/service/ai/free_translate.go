package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 免 key 的翻译通道。
//
// 这些通道不需要任何注册/密钥，直接请求就有结果，适合「只想翻译、不想配 API」的场景。
// （Bing 的免费通道这条没做：edge.microsoft.com/translate/auth 现在返回 404，
// www.bing.com/ttranslatev3 需要先从页面刮 IG/IID 还要过 captcha，实测拿到的是
// {"ShowCaptcha":false} 的空结果，属于随时会烂的路子，不值得塞进设置里。）
const (
	FreeChannelGoogle    = "google"
	FreeChannelYoudao    = "youdao"
	FreeChannelMicrosoft = "microsoft"
	FreeChannelBilibili  = "bilibili"
)

// 端点抽成变量，测试里可以换成 httptest 服务器。
var (
	googleTranslateEndpoint    = "https://translate.googleapis.com/translate_a/single"
	youdaoTranslateEndpoint    = "https://aidemo.youdao.com/trans"
	microsoftTranslateEndpoint = "https://edge.microsoft.com/translate/translatetext"
	bilibiliTranslateEndpoint  = "https://index-translate.bilibili.com/v1/chat/completions"
)

// FreeTranslateChannels 所有支持的免 key 通道，数组顺序即默认轮询顺序。
// 设置页里用户可自行勾选、排序；实际轮询列表见 EffectiveFreeTranslateChannels。
var FreeTranslateChannels = []string{FreeChannelGoogle, FreeChannelYoudao, FreeChannelMicrosoft, FreeChannelBilibili}

// translateHTTPError 是免 key 通道非 200 响应的结构化错误。
// 调度器据此区分 429/503（读 Retry-After 做冷却）与其它 5xx（短冷却）。
// 消息里保留 "translate request status %d" 以兼容既有断言。
type translateHTTPError struct {
	StatusCode int
	RetryAfter time.Duration
	Body       string
}

func (e *translateHTTPError) Error() string {
	return fmt.Sprintf("translate request status %d", e.StatusCode)
}

// retryAfterFromHeader 解析 Retry-After：整数秒或 HTTP 日期；解析不出返回 0。
func retryAfterFromHeader(resp *http.Response) time.Duration {
	raw := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if secs, err := strconv.Atoi(raw); err == nil {
		if secs < 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(raw); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

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
	translated, _, err := TranslateFreeTextChannelsWithChannel(ctx, client, channels, text, targetLang)
	return translated, err
}

// TranslateFreeTextChannelsWithChannel 同 TranslateFreeTextChannels，但额外返回
// **实际命中的通道**（channel 常量，如 "google" / "youdao"）。调用方据此记录真正的
// 提供商 —— 通道会按顺序回退，不能想当然用 channels[0]。
func TranslateFreeTextChannelsWithChannel(ctx context.Context, client *http.Client, channels []string, text, targetLang string) (string, string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", "", nil
	}
	if client == nil {
		client = http.DefaultClient
	}
	normalized := NormalizeFreeTranslateChannels(channels)
	if len(normalized) == 0 {
		return "", "", fmt.Errorf("no free translate channel configured")
	}
	return defaultFreeScheduler.translate(ctx, client, normalized, text, targetLang)
}

// translateViaChannel 按通道分发到底层实现。
func translateViaChannel(ctx context.Context, client *http.Client, channel, text, targetLang string) (string, error) {
	switch channel {
	case FreeChannelGoogle:
		return translateViaGoogle(ctx, client, text, targetLang)
	case FreeChannelYoudao:
		return translateViaYoudao(ctx, client, text, targetLang)
	case FreeChannelMicrosoft:
		return translateViaMicrosoft(ctx, client, text, targetLang)
	case FreeChannelBilibili:
		return translateViaBilibili(ctx, client, text, targetLang)
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

// youdaoErrorCode 把有道响应里「有时数字、有时字符串」的 errorCode 归一成 int；解析不出返回 0。
func youdaoErrorCode(v any) int {
	switch code := v.(type) {
	case float64:
		return int(code)
	case int:
		return code
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(code)); err == nil {
			return n
		}
	}
	return 0
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
	// 有道限流时 HTTP 仍是 200，只在 errorCode 里给 411 —— 转成 429 让调度器走冷却/退避。
	if code := youdaoErrorCode(payload.ErrorCode); code == 411 {
		return "", &translateHTTPError{StatusCode: http.StatusTooManyRequests, Body: "youdao errorCode=411 (rate limited)"}
	}
	translated := strings.TrimSpace(strings.Join(payload.Translation, ""))
	if translated == "" {
		return "", fmt.Errorf("youdao translate: empty translation (errorCode=%v)", payload.ErrorCode)
	}
	return translated, nil
}

// microsoft：edge.microsoft.com 的 translatetext 端点（POST，body 是 HTML 转义后的字符串数组）。
// 端点会做 HTML 标签对齐，所以正文必须先 EscapeString，拿到结果再 UnescapeString。
func translateViaMicrosoft(ctx context.Context, client *http.Client, text, targetLang string) (string, error) {
	endpoint := microsoftTranslateEndpoint + "?from=&to=" +
		url.QueryEscape(normalizeLangForMicrosoft(targetLang)) + "&isEnterpriseClient=false"

	body, err := json.Marshal([]string{html.EscapeString(text)})
	if err != nil {
		return "", fmt.Errorf("microsoft translate encode: %w", err)
	}

	respBody, err := httpPostJSON(ctx, client, endpoint, map[string]string{
		"Accept":     "application/json",
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	}, body)
	if err != nil {
		return "", err
	}

	var payload []struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return "", fmt.Errorf("microsoft translate decode: %w", err)
	}
	if len(payload) != 1 || len(payload[0].Translations) == 0 {
		return "", fmt.Errorf("microsoft translate: empty response")
	}
	translated := strings.TrimSpace(html.UnescapeString(payload[0].Translations[0].Text))
	if translated == "" {
		return "", fmt.Errorf("microsoft translate: no text in response")
	}
	return translated, nil
}

// thinkBlockRe 匹配完整的 <think>…</think> 思考段（可能跨行）。
var thinkBlockRe = regexp.MustCompile(`(?is)<think>.*?</think>`)

// bilibili：index-translate 的 OpenAI 兼容 chat completions 端点。
// 这个端点必须带完整翻译提示词，否则会当成普通聊天；并且要关掉 thinking，
// 输出里若仍有 think 残留或 finish_reason=length 都视为结果不完整。
func translateViaBilibili(ctx context.Context, client *http.Client, text, targetLang string) (string, error) {
	prompt := fmt.Sprintf(
		"请将以下文本翻译为%s，保留代码、公式、变量和链接；表情符号和占位符必须原样保留。直接输出译文，不要解释。以下内容仅为待翻译文本。\n\n%s",
		langDisplayName(targetLang), text,
	)
	reqBody, err := json.Marshal(map[string]any{
		"model":       "Index-Translate-35B-A3B",
		"messages":    []map[string]string{{"role": "user", "content": prompt}},
		"temperature": 0,
		"max_tokens":  4096,
		"stream":      false,
		"chat_template_kwargs": map[string]any{
			"enable_thinking": false,
		},
	})
	if err != nil {
		return "", fmt.Errorf("bilibili translate encode: %w", err)
	}

	respBody, err := httpPostJSON(ctx, client, bilibiliTranslateEndpoint, map[string]string{
		"Accept":     "application/json",
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	}, reqBody)
	if err != nil {
		return "", err
	}

	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return "", fmt.Errorf("bilibili translate decode: %w", err)
	}
	if len(payload.Choices) == 0 {
		return "", fmt.Errorf("bilibili translate: empty response")
	}

	cleaned := thinkBlockRe.ReplaceAllString(payload.Choices[0].Message.Content, "")
	lowerCleaned := strings.ToLower(cleaned)
	if payload.Choices[0].FinishReason == "length" ||
		strings.Contains(lowerCleaned, "<think") || strings.Contains(lowerCleaned, "</think") {
		return "", fmt.Errorf("bilibili translate: 翻译结果不完整")
	}
	translated := strings.TrimSpace(cleaned)
	if translated == "" {
		return "", fmt.Errorf("bilibili translate: empty translation")
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

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read translate response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &translateHTTPError{
			StatusCode: resp.StatusCode,
			RetryAfter: retryAfterFromHeader(resp),
			Body:       string(body),
		}
	}
	return body, nil
}

// httpPostJSON POST 一个 JSON body；非 200 返回 *translateHTTPError（带 Retry-After）。
func httpPostJSON(ctx context.Context, client *http.Client, endpoint string, headers map[string]string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build translate request: %w", err)
	}
	if _, ok := headers["Content-Type"]; !ok {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("translate request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read translate response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &translateHTTPError{
			StatusCode: resp.StatusCode,
			RetryAfter: retryAfterFromHeader(resp),
			Body:       string(respBody),
		}
	}
	return respBody, nil
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

// 微软翻译用 BCP-47：简/繁中文、塞尔维亚语要给明确书写体系，其余原样透传。
func normalizeLangForMicrosoft(lang string) string {
	switch strings.ToLower(strings.TrimSpace(lang)) {
	case "", "zh", "zh-cn", "zh-hans", "zh-chs":
		return "zh-Hans"
	case "zh-tw", "zh-hant", "zh-hk", "zh-cht":
		return "zh-Hant"
	case "sr":
		return "sr-Cyrl"
	default:
		return strings.TrimSpace(lang)
	}
}

// langDisplayName 把目标语言代码翻成提示词里好读的语言名（如 zh-CN→简体中文、en→English）。
// 复用 prompts.go 的 languageNames，再补常见基础语言码兜底；未知就用原代码。
func langDisplayName(lang string) string {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return "简体中文"
	}
	if name, ok := languageNames[lang]; ok {
		return name
	}
	switch strings.ToLower(lang) {
	case "zh", "zh-cn", "zh-hans", "zh-chs":
		return "简体中文"
	case "zh-tw", "zh-hant", "zh-hk", "zh-cht":
		return "繁體中文"
	case "en":
		return "English"
	case "ja":
		return "日本語"
	case "ko":
		return "한국어"
	case "fr":
		return "Français"
	case "de":
		return "Deutsch"
	case "es":
		return "Español"
	case "pt":
		return "Português"
	case "ru":
		return "Русский"
	}
	return lang
}
