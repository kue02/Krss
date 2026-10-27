// 插件自有数据（单库：存在宿主的 plugin_data 表里）。
//
// 为什么是「调宿主」而不是插件自己落盘：插件进程和它的沙箱页面必须看到同一份数据。
// 插件页面在沙箱里只能走宿主 bridge，所以真相只能有一处 —— 宿主库。
// 插件进程没有登录态，靠宿主 spawn 时注入的两样东西进自己那扇门：
//
//	KRSS_PLUGIN_API    宿主 HTTP 基址（http://127.0.0.1:8082）
//	KRSS_PLUGIN_TOKEN  本次 spawn 的随机 token（认证中间件只放行 /api/plugins/<自己>/data/*）
//
// 一枚 token 只能读写**自己**的 data；别人的 collection 连路径都拼不出来。
package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Data 插件自己的键值数据。零值不可用，用 NewData 构造。
type Data struct {
	api      string
	token    string
	pluginID string
	client   *http.Client
}

// NewData 读宿主注入的环境变量。缺 API/TOKEN/ID 时返回的 Data 会在每次调用上报错
// （而不是 panic：插件可能被单独跑起来做冒烟，那时没有宿主）。
func NewData() *Data {
	return &Data{
		api:      strings.TrimRight(strings.TrimSpace(os.Getenv("KRSS_PLUGIN_API")), "/"),
		token:    strings.TrimSpace(os.Getenv("KRSS_PLUGIN_TOKEN")),
		pluginID: strings.TrimSpace(os.Getenv("KRSS_PLUGIN_ID")),
		client:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Usable 宿主环境是否齐（缺就说明插件是单独跑起来的）。
func (d *Data) Usable() bool {
	return d != nil && d.api != "" && d.token != "" && d.pluginID != ""
}

func (d *Data) url(collection string, key string, query url.Values) (string, error) {
	if !d.Usable() {
		return "", fmt.Errorf("插件数据通道不可用：宿主没有注入 KRSS_PLUGIN_API/TOKEN/ID")
	}
	if strings.TrimSpace(collection) == "" {
		return "", fmt.Errorf("collection 不能为空")
	}
	base := d.api + "/api/plugins/" + url.PathEscape(d.pluginID) + "/data/" + url.PathEscape(collection)
	if key != "" {
		base += "/" + url.PathEscape(key)
	}
	if len(query) > 0 {
		base += "?" + query.Encode()
	}
	return base, nil
}

func (d *Data) do(ctx context.Context, method, target string, body any, out any) (int, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, err
	}
	req.Header.Set("X-Krss-Plugin-Token", d.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &failure)
		reason := strings.TrimSpace(failure.Error)
		if reason == "" {
			reason = strings.TrimSpace(string(raw))
		}
		return resp.StatusCode, fmt.Errorf("插件数据 %s %s: HTTP %d %s", method, target, resp.StatusCode, reason)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, err
		}
	}
	return resp.StatusCode, nil
}

// Get 读一个值；不存在返回 ("", false, nil)，让调用方自己决定算不算错。
func (d *Data) Get(ctx context.Context, collection, key string) (string, bool, error) {
	target, err := d.url(collection, key, nil)
	if err != nil {
		return "", false, err
	}
	var out struct {
		Value string `json:"value"`
	}
	status, err := d.do(ctx, http.MethodGet, target, nil, &out)
	if status == http.StatusNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return out.Value, true, nil
}

// Put 写一个值（value 是不透明字符串：插件自己 JSON 序列化，宿主不改一个字节）。
func (d *Data) Put(ctx context.Context, collection, key, value string) error {
	target, err := d.url(collection, key, nil)
	if err != nil {
		return err
	}
	_, err = d.do(ctx, http.MethodPut, target, map[string]string{"value": value}, nil)
	return err
}

// List 列一个 collection（可按 key 前缀过滤）。
func (d *Data) List(ctx context.Context, collection, prefix string) (map[string]string, error) {
	query := url.Values{}
	if prefix != "" {
		query.Set("prefix", prefix)
	}
	target, err := d.url(collection, "", query)
	if err != nil {
		return nil, err
	}
	var out struct {
		Values map[string]string `json:"values"`
	}
	if _, err := d.do(ctx, http.MethodGet, target, nil, &out); err != nil {
		return nil, err
	}
	if out.Values == nil {
		return map[string]string{}, nil
	}
	return out.Values, nil
}

// Delete 删一个键（不存在算成功：目标状态已达成）。
func (d *Data) Delete(ctx context.Context, collection, key string) error {
	target, err := d.url(collection, key, nil)
	if err != nil {
		return err
	}
	status, err := d.do(ctx, http.MethodDelete, target, nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	return err
}
