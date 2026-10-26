// Package bark Bark 推送插件：本体搬来的第一个真实插件。
//
// 与本体期的语义完全一致——地址两层（规则里填的优先，留空跟插件全局地址），
// 报文 {title, body, url, group}，UA krss-notify/1。地址里带设备 key（凭证），
// 所以错误信息里的目标地址要打码（只留 host），免得 key 进规则 last_error 与日志。
package bark

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/pkg/network"
)

func init() { plugin.MustRegister(New()) }

// New 造插件实例（init() 自注册也走这里）。
// 出网 client 与设置存储由 main.go 在装配期用 Configure 填进来——init() 发生在 main 之前，拿不到它们。
func New() plugin.Plugin { return Plugin{} }

// 包级装配状态：Configure 填一次，之后整个进程共用（单实例后端，不需要更细的粒度）。
var (
	store      plugin.SettingsStore
	httpClient *http.Client
)

// Configure 装出网 client 与设置存储（main.go 调一次；测试直接给 httptest client + fake store）。
// client 用 clientFactory 建，才能继承代理设置（与 webhook / 抓取同一套出网路径）。
func Configure(client *http.Client, settings plugin.SettingsStore) {
	if client != nil {
		httpClient = client
	}
	store = settings
}

// Plugin Bark 推送插件。
type Plugin struct{}

func (Plugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:          "bark",
		Name:        "Bark 推送",
		Description: "规则命中后推一条到手机（Bark 兼容协议）。与自动化规则的「推送」动作联动。",
		Version:     "1.0.0",
		Builtin:     true,
	}
}

// settings 插件自己的设置助手（键 plugin.bark.url）。
func (Plugin) settings() plugin.Settings {
	return plugin.Settings{PluginID: "bark", Store: store}
}

func (Plugin) Actions() []plugin.Action { return []plugin.Action{notifyAction{}} }

// SettingsSections 设置弹窗「插件」页里的推送段（全局地址；测试按钮走动作测试接口）。
func (Plugin) SettingsSections() []plugin.SettingsSection {
	return []plugin.SettingsSection{{
		ID:    "bark-notify",
		Title: "推送地址（Bark）",
		Fields: []plugin.Field{{
			Key:         "url",
			Label:       "全局推送地址（规则没填地址时走这里）",
			Type:        "secret",
			Placeholder: "https://api.day.app/<你的 key>",
			Help:        "地址里带设备 key，只存在你自己的库里；测试推送走规则同一条发送路径。",
		}},
	}}
}

func (Plugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (Plugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// notifyAction 「命中后推一条到手机」。地址两层：规则里填的优先，留空跟插件全局地址。
type notifyAction struct{}

func (notifyAction) ID() string    { return "notify" }
func (notifyAction) Label() string { return "推送到手机（Bark）" }

func (notifyAction) Fields() []plugin.Field {
	return []plugin.Field{{
		Key:         "url",
		Label:       "推送地址（留空 = 用插件全局地址）",
		Type:        "secret",
		Placeholder: "https://api.day.app/<你的 key>",
	}}
}

func (a notifyAction) Execute(ctx context.Context, req plugin.ActionRequest) error {
	target := strings.TrimSpace(req.Config["url"])
	if target == "" {
		target = Plugin{}.settings().Get(ctx, "url")
	}
	if target == "" {
		return errors.New("规则没填推送地址，插件里也没有全局推送地址")
	}
	payload, err := json.Marshal(BuildNotifyPayload(req.Filter, req.Feed, req.Entry))
	if err != nil {
		return fmt.Errorf("构造推送内容失败：%w", err)
	}
	return postJSON(ctx, target, payload)
}

// Test 发一条测试推送（设置页「发送测试」）。与规则命中走同一条发送路径，
// 通了就说明地址 / 代理 / 出网都对。
func (a notifyAction) Test(ctx context.Context) error {
	target := Plugin{}.settings().Get(ctx, "url")
	if target == "" {
		return errors.New("先填全局推送地址再测试")
	}
	return postJSON(ctx, target, []byte(`{"title":"Krss 测试推送","body":"如果你收到这条，说明推送通道通了。"}`))
}

// ---- 以下是从 notify_service.go 搬来的报文与发送实现（55 批，行为保持一致）----

// NotifyPayload Bark 兼容的推送报文。
type NotifyPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	Group string `json:"group,omitempty"`
}

const (
	notifyTimeout    = 10 * time.Second
	notifyTitleLimit = 60
	notifyBodyLimit  = 120
)

// BuildNotifyPayload 构造推送报文。**口径必须与本体 NotifyService 逐字节一致**（55-13 搬走时
// 用户可见行为零变化）：title = 条目标题（空则「（无标题）」）；body = 来源 · 规则「名字」；
// url = 条目链接；group 固定「Krss 自动化」。改动前先 `git show 8089049^:backend/internal/service/notify_service.go` 对照。
func BuildNotifyPayload(filter model.Filter, feed model.Feed, entry model.Entry) NotifyPayload {
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
	return NotifyPayload{
		Title: truncateRunes(title, notifyTitleLimit),
		Body:  truncateRunes(strings.Join(parts, " · "), notifyBodyLimit),
		URL:   link,
		Group: "Krss 自动化",
	}
}

// postJSON POST JSON + 读回一小段 body 当原因；UA 固定 krss-notify/1，
// 便于在 Bark / 反向代理日志里分辨是谁发的。
func postJSON(ctx context.Context, target string, payload []byte) error {
	reqCtx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return redactError(err, target)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "krss-notify/1")
	resp, err := client().Do(req)
	if err != nil {
		return fmt.Errorf("%s（目标 %s）", redactTarget(err.Error(), target), network.ExtractHost(target))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		reason := redactTarget(strings.TrimSpace(string(body)), target)
		return fmt.Errorf("HTTP %d %s（目标 %s）", resp.StatusCode, reason, network.ExtractHost(target))
	}
	return nil
}

// client 取装配进来的出网 client；没装配时用默认 client 兜底（测试与「忘了 Configure」都不至于 nil panic）。
func client() *http.Client {
	if httpClient != nil {
		return httpClient
	}
	return &http.Client{Timeout: notifyTimeout}
}

// redactError 把构造请求失败的错误也过一遍打码（目标非法时错误里可能带整条地址）。
func redactError(err error, target string) error {
	return fmt.Errorf("%s", redactTarget(err.Error(), target))
}

// redactTarget 把错误里出现的推送地址换成主机名 —— 地址带设备 key（凭证），
// 而这条原因会写进规则 last_error、也会进日志，不能把 key 带出去。
// 除了整条地址，还会把地址末段（Bark 的 key）单独抹掉：服务端错误体里常常只回显 key。
func redactTarget(message, target string) string {
	if message == "" || target == "" {
		return message
	}
	host := network.ExtractHost(target)
	out := strings.ReplaceAll(message, target, host)
	if key := targetKey(target); key != "" {
		out = strings.ReplaceAll(out, key, "***")
	}
	return out
}

// targetKey 地址末段（Bark 的 key）；太短的不当 key（避免误伤普通词）。
func targetKey(target string) string {
	u, err := url.Parse(target)
	if err != nil {
		return ""
	}
	key := strings.Trim(u.Path, "/")
	if i := strings.LastIndex(key, "/"); i >= 0 {
		key = key[i+1:]
	}
	if len(key) < 6 {
		return ""
	}
	return key
}

// truncateRunes 按字符截断（中文按字数算，不按字节）。
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
