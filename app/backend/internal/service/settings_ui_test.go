package service_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"krss/backend/internal/service"
	"krss/backend/internal/service/ai"

	"github.com/stretchr/testify/require"
)

func newUISettingsService() (*settingsRepoStub, service.SettingsService) {
	repo := newSettingsRepoStub()
	return repo, service.NewSettingsService(repo, ai.NewRateLimiter(0))
}

func TestSettingsService_GetUISettings_EmptyWhenNothingStored(t *testing.T) {
	_, svc := newUISettingsService()

	got, err := svc.GetUISettings(context.Background())
	require.NoError(t, err)

	require.True(t, got.Empty, "一条都没存过时 Empty 必须为 true（前端据此决定首次迁移）")
	require.JSONEq(t, `{}`, string(got.UI))
	require.JSONEq(t, `{}`, string(got.SidebarState))
	require.Empty(t, got.Lang)
	require.True(t, got.UpdatedAt.IsZero())
}

func TestSettingsService_GetUISettings_NotPausedByUnrelatedKeys(t *testing.T) {
	repo, svc := newUISettingsService()
	// 其它设置存在，但界面设置一条都没有 ⇒ 仍然是「空」
	repo.data[service.KeyAIProvider] = "compatible"
	repo.data[service.KeyMarkReadOnScroll] = "true"

	got, err := svc.GetUISettings(context.Background())
	require.NoError(t, err)
	require.True(t, got.Empty)
}

func TestSettingsService_SetUISettings_TransparentPassthrough(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()

	// 形状就是前端的形状：shared + 按设备分套，而且故意塞一个「后端不认识」的字段 ——
	// 后端不建模、原样透传，这是这一版最重要的性质（DTO 少字段导致设置静默失效是踩过的坑）。
	payload := `{"shared":{"feedColWidth":256,"cardPreviewLines":2,"someFutureField":{"deep":[1,2,3]}},"device":{"desktop":{"uiScale":1.25},"mobile":{"feedColWidth":200}}}`

	require.NoError(t, svc.SetUISettings(ctx, &service.UISettings{UI: json.RawMessage(payload)}))
	require.Equal(t, payload, repo.data[service.KeyUISettings])

	got, err := svc.GetUISettings(ctx)
	require.NoError(t, err)
	require.False(t, got.Empty)
	require.False(t, got.UpdatedAt.IsZero())
	require.JSONEq(t, payload, string(got.UI))
}

func TestSettingsService_SetUISettings_OnlyWritesProvidedParts(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()

	// 先存整包，再「只改主题」——整包不能被清掉
	require.NoError(t, svc.SetUISettings(ctx, &service.UISettings{
		UI:           json.RawMessage(`{"shared":{"uiScale":1}}`),
		Lang:         "zh",
		SidebarState: json.RawMessage(`{"技术":true}`),
	}))

	require.NoError(t, svc.SetUISettings(ctx, &service.UISettings{
		Theme: service.UIThemeSettings{Mode: "dark", LightTheme: "stone", DarkTheme: "nord-dark"},
	}))

	require.Equal(t, `{"shared":{"uiScale":1}}`, repo.data[service.KeyUISettings])
	require.Equal(t, `{"技术":true}`, repo.data[service.KeyUISidebarState])

	got, err := svc.GetUISettings(ctx)
	require.NoError(t, err)
	require.Equal(t, "zh", got.Lang)
	require.Equal(t, "dark", got.Theme.Mode)
	require.Equal(t, "nord-dark", got.Theme.DarkTheme)
	require.JSONEq(t, `{"shared":{"uiScale":1}}`, string(got.UI))
	require.JSONEq(t, `{"技术":true}`, string(got.SidebarState))
}

func TestSettingsService_SetUISettings_RejectsBadPayloads(t *testing.T) {
	_, svc := newUISettingsService()
	ctx := context.Background()

	cases := []struct {
		name string
		body *service.UISettings
	}{
		{"nil", nil},
		{"空包", &service.UISettings{}},
		{"ui 不是对象（数组）", &service.UISettings{UI: json.RawMessage(`[1,2,3]`)}},
		{"ui 不是合法 json", &service.UISettings{UI: json.RawMessage(`{oops`)}},
		{"sidebarState 不是对象", &service.UISettings{SidebarState: json.RawMessage(`"hello"`)}},
		{"主题模式不在三档内", &service.UISettings{Theme: service.UIThemeSettings{Mode: "rainbow"}}},
		{"主题模式为空（等于没传但有结构）", &service.UISettings{Theme: service.UIThemeSettings{Mode: "", LightTheme: "light"}}},
		{"配色 id 带空格", &service.UISettings{Theme: service.UIThemeSettings{Mode: "dark", DarkTheme: "nord dark"}}},
		{"语言带空格", &service.UISettings{Lang: "zh CN"}},
		{"语言超长", &service.UISettings{Lang: strings.Repeat("z", 64)}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := svc.SetUISettings(ctx, tc.body)
			require.ErrorIs(t, err, service.ErrInvalid)
		})
	}
}

func TestSettingsService_SetUISettings_RejectsOversizedPayload(t *testing.T) {
	_, svc := newUISettingsService()

	huge := json.RawMessage(`{"shared":{"blob":"` + strings.Repeat("x", 256*1024) + `"}}`)
	err := svc.SetUISettings(context.Background(), &service.UISettings{UI: huge})
	require.ErrorIs(t, err, service.ErrInvalid)
	require.Contains(t, err.Error(), "too large")
}

func TestSettingsService_ExportSettings_ExcludesCredentials(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()

	repo.data[service.KeyAIProvider] = "compatible"
	repo.data[service.KeyMarkReadOnScroll] = "true"
	repo.data[service.KeyAIBaseURL] = "http://127.0.0.1:8000/v1"
	repo.data[service.KeyUILang] = "zh"

	// 凭证类：一个都不许出现在导出文件里
	repo.data[service.KeyAIAPIKey] = "sk-secret-123456"
	repo.data[service.KeyNetworkPassword] = "proxypass"
	repo.data[service.KeyUserPasswordHash] = "$2a$10$hash"
	repo.data[service.KeyUserJWTSecret] = "jwt-secret"
	repo.data["anubis.cookie.example.com"] = "session-cookie"

	out, err := svc.ExportSettings(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, out.Version)
	require.False(t, out.ExportedAt.IsZero())

	require.Contains(t, out.Settings, service.KeyAIProvider)
	require.Contains(t, out.Settings, service.KeyUILang)
	// 没存过的键不出现（导出文件只写真实存在的配置）
	require.NotContains(t, out.Settings, service.KeyAIModel)

	for _, key := range []string{service.KeyAIAPIKey, service.KeyNetworkPassword, service.KeyUserPasswordHash, service.KeyUserJWTSecret, "anubis.cookie.example.com"} {
		require.NotContains(t, out.Settings, key, "凭证键 %s 不该进导出文件", key)
	}
	require.Contains(t, out.ExcludedKeys, service.KeyAIAPIKey)

	// 凭证确实没被串进文件（对着序列化后的全文再查一遍）
	require.NotContains(t, string(mustJSON(t, out)), "sk-secret-123456")
	require.NotContains(t, string(mustJSON(t, out)), "jwt-secret")
}

func TestSettingsService_ImportExport_RoundTrip(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()

	// 库里真实存在的那几种值形态：裸字符串 / 布尔文本 / 数字文本 / JSON 对象
	repo.data[service.KeyAIProvider] = "compatible"
	repo.data[service.KeyMarkReadOnScroll] = "true"
	repo.data[service.KeyAIRateLimit] = "8"
	repo.data[service.KeyAISummaryLanguage] = "zh-CN"
	repo.data[service.KeyFallbackUserAgent] = ""
	repo.data[service.KeyUISettings] = `{"shared":{"uiScale":1.25},"device":{"desktop":{},"mobile":{}}}`
	repo.data[service.KeyUITheme] = `{"mode":"dark","lightTheme":"stone","darkTheme":"dark"}`
	repo.data[service.KeyUILang] = "en"

	exported, err := svc.ExportSettings(ctx)
	require.NoError(t, err)

	// 清库 → 导入 → 值必须一模一样（可逆）
	repo.data = map[string]string{}
	require.NoError(t, svc.ImportSettings(ctx, exported))

	require.Equal(t, "compatible", repo.data[service.KeyAIProvider])
	require.Equal(t, "true", repo.data[service.KeyMarkReadOnScroll])
	require.Equal(t, "8", repo.data[service.KeyAIRateLimit])
	require.Equal(t, "zh-CN", repo.data[service.KeyAISummaryLanguage])
	require.Equal(t, "", repo.data[service.KeyFallbackUserAgent])
	require.Equal(t, `{"shared":{"uiScale":1.25},"device":{"desktop":{},"mobile":{}}}`, repo.data[service.KeyUISettings])
	require.Equal(t, `{"mode":"dark","lightTheme":"stone","darkTheme":"dark"}`, repo.data[service.KeyUITheme])
	require.Equal(t, "en", repo.data[service.KeyUILang])
}

func TestSettingsService_ImportSettings_RejectsUnknownKeys(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()
	repo.data[service.KeyAIProvider] = "compatible"

	payload := &service.SettingsExport{
		Version:  1,
		Settings: map[string]json.RawMessage{service.KeyAIProvider: json.RawMessage(`"openai"`), "hacker.key": json.RawMessage(`"x"`)},
	}

	err := svc.ImportSettings(ctx, payload)
	require.ErrorIs(t, err, service.ErrUnknownSettingKey)
	// 报错要把键名带上；而且**一个字都不能写进去**（不许「导入一半」）
	require.Contains(t, err.Error(), "hacker.key")
	require.Equal(t, "compatible", repo.data[service.KeyAIProvider])
}

func TestSettingsService_ImportSettings_RejectsBadStructuredValues(t *testing.T) {
	repo, svc := newUISettingsService()
	ctx := context.Background()

	cases := []struct {
		name  string
		key   string
		value string
	}{
		{"主题模式非法", service.KeyUITheme, `{"mode":"rainbow","lightTheme":"light","darkTheme":"dark"}`},
		{"界面设置不是对象", service.KeyUISettings, `[1,2,3]`},
		{"侧栏状态不是对象", service.KeyUISidebarState, `"nope"`},
		{"语言非法", service.KeyUILang, `"zh CN"`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := svc.ImportSettings(ctx, &service.SettingsExport{
				Version:  1,
				Settings: map[string]json.RawMessage{tc.key: json.RawMessage(tc.value)},
			})
			require.ErrorIs(t, err, service.ErrInvalid)
			require.Empty(t, repo.data)
		})
	}
}

func TestSettingsService_ImportSettings_RejectsEmptyPayload(t *testing.T) {
	_, svc := newUISettingsService()

	require.ErrorIs(t, svc.ImportSettings(context.Background(), nil), service.ErrInvalid)
	require.ErrorIs(t, svc.ImportSettings(context.Background(), &service.SettingsExport{}), service.ErrInvalid)
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return encoded
}
