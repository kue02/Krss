package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
)

// 推送通道（Bark 兼容）：规则命中 → 推一条到手机。
//
// 地址有两层，**规则里填的优先**：
//  1. 规则动作的 notifyUrl（可以让不同规则推到不同设备 / 不同分组）
//  2. 设置里的全局 notify.bark_url（规则没填就跟随它）
//
// Bark 的用法就是「POST 到 <地址> + JSON {title, body, url, group}」，与 webhook 是同一套语义，
// 所以发送器直接复用 FilterWebhookSender（只是 UA 不同，便于在下游日志里分辨）。
const filterNotifyTimeout = 10 * time.Second

// errNotifySenderDisabled：服务没装发送器（只可能出现在测试里）——要明确报错，不能静默当成发成功
var errNotifySenderDisabled = errors.New("notify sender disabled")

// FilterNotifyPayload Bark 兼容的推送报文。
type FilterNotifyPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	Group string `json:"group,omitempty"`
}

// 推送标题/正文里条目的截断长度（手机上太长反而看不清）
const (
	notifyTitleLimit = 60
	notifyBodyLimit  = 120
)

// NewHTTPNotifier 与 webhook 发送器共用实现（同样的 POST JSON + 读回一小段 body 当原因），
// 只把 UA 换成 gist-notify/1，便于在 Bark / 反向代理日志里分辨是谁发的。
func NewHTTPNotifier(client *http.Client) FilterWebhookSender {
	return &httpWebhookSender{client: client, userAgent: "gist-notify/1"}
}

// NotifyService 推送通道：设置里的全局地址 + 真正发送。
type NotifyService interface {
	// GlobalURL 设置里的全局 Bark 地址（没配就是空串）
	GlobalURL(ctx context.Context) string
	// Send 真的发一条（返回 HTTP 状态码）
	Send(ctx context.Context, target string, payload []byte) (int, error)
}

type notifyService struct {
	settings repository.SettingsRepository
	sender   FilterWebhookSender
}

// NewNotifyService 建推送通道（sender 为 nil 时 Send 会明确报错，不会静默成功）。
func NewNotifyService(settings repository.SettingsRepository, sender FilterWebhookSender) NotifyService {
	return &notifyService{settings: settings, sender: sender}
}

func (s *notifyService) GlobalURL(ctx context.Context) string {
	if s.settings == nil {
		return ""
	}
	setting, err := s.settings.Get(ctx, keyNotifyBarkURL)
	if err != nil || setting == nil {
		return ""
	}
	return strings.TrimSpace(setting.Value)
}

func (s *notifyService) Send(ctx context.Context, target string, payload []byte) (int, error) {
	if s.sender == nil {
		return 0, errNotifySenderDisabled
	}
	return s.sender.Send(ctx, target, payload)
}

// BuildFilterNotifyPayload 把「规则命中」拼成手机上一眼能看懂的一条推送：
// 标题 = 条目标题，正文 = 来源 · 规则名，点开直达条目。
func BuildFilterNotifyPayload(filter model.Filter, feed model.Feed, entry model.Entry) FilterNotifyPayload {
	title := ""
	if entry.Title != nil {
		title = strings.TrimSpace(*entry.Title)
	}
	if title == "" {
		title = "（无标题）"
	}
	link := ""
	if entry.URL != nil {
		link = strings.TrimSpace(*entry.URL)
	}
	parts := make([]string, 0, 2)
	if feedTitle := strings.TrimSpace(feed.Title); feedTitle != "" {
		parts = append(parts, feedTitle)
	}
	if filterName := strings.TrimSpace(filter.Name); filterName != "" {
		parts = append(parts, "规则「"+filterName+"」")
	}
	return FilterNotifyPayload{
		Title: truncateRunes(title, notifyTitleLimit),
		Body:  truncateRunes(strings.Join(parts, " · "), notifyBodyLimit),
		URL:   link,
		Group: "Gist 自动化",
	}
}

// MarshalFilterNotify 给发送器用的字节流。
func MarshalFilterNotify(payload FilterNotifyPayload) ([]byte, error) {
	return json.Marshal(payload)
}
