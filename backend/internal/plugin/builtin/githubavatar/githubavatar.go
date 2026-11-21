// Package githubavatar 内置插件：让 GitHub 订阅源显示账号头像。
//
// GitHub 官方 RSS/Atom 不含头像，订阅列表只能用通用 favicon。本插件实现
// plugin.FeedIconProvider，从订阅 URL 解析出账号名，返回 github.com/{user}.png。
package githubavatar

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
)

const pluginID = "githubavatar"

// githubUserPattern GitHub 账号名：字母、数字、连字符。
var githubUserPattern = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// reservedPaths 不是账号名的保留一级路径（github.com 的功能页）。
var reservedPaths = map[string]struct{}{
	"features": {}, "topics": {}, "collections": {}, "events": {}, "explore": {},
	"marketplace": {}, "pricing": {}, "settings": {}, "organizations": {}, "sponsors": {},
	"about": {}, "login": {}, "join": {}, "notifications": {}, "new": {}, "search": {},
	"trending": {}, "apps": {}, "codespaces": {}, "security": {}, "enterprise": {},
	"team": {}, "contact": {},
}

func init() {
	plugin.Default.Register(Plugin{})
}

// Plugin githubavatar 插件。
type Plugin struct{}

// Meta 插件元信息。
func (Plugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:          pluginID,
		Name:        "GitHub 头像",
		Description: "让 GitHub 订阅源显示账号头像",
		Version:     "1.0.0",
		Builtin:     true,
		Transport:   plugin.TransportBuiltin,
		// DefaultEnabled 留 nil = 默认启用。
	}
}

// ID 插件 id。
func (Plugin) ID() string { return pluginID }

// Actions 无。
func (Plugin) Actions() []plugin.Action { return nil }

// SettingsSections 无。
func (Plugin) SettingsSections() []plugin.SettingsSection { return nil }

// EntryProcessors 无。
func (Plugin) EntryProcessors() []plugin.EntryProcessor { return nil }

// FetchClassifiers 无。
func (Plugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// FeedIcon 从订阅 URL（或站点 URL）解析 GitHub 账号名，返回头像 URL；不认识的订阅返回空串。
func (Plugin) FeedIcon(_ context.Context, feed model.Feed) (string, error) {
	candidates := []string{feed.URL}
	if feed.SiteURL != nil {
		candidates = append(candidates, *feed.SiteURL)
	}
	for _, raw := range candidates {
		if user := userFromGitHubURL(raw); user != "" {
			return "https://github.com/" + user + ".png?size=120", nil
		}
	}
	return "", nil
}

// userFromGitHubURL 解析 github.com 的 Atom 订阅路径，取第一段账号名；不匹配返回空串。
//
// 支持的形态：/{user}.atom、/{user}/{repo}/releases.atom、
// /{user}/{repo}/commits/{branch}.atom、/{user}/{repo}/tags.atom、
// /{user}/{repo}/discussions.atom 等一切以 .atom 结尾的路径。
func userFromGitHubURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "github.com" && host != "www.github.com" {
		return ""
	}

	path := strings.Trim(parsed.Path, "/")
	if !strings.HasSuffix(path, ".atom") {
		return ""
	}
	parts := strings.Split(path, "/")
	if len(parts) == 0 {
		return ""
	}
	user := parts[0]
	if len(parts) == 1 {
		// /{user}.atom
		user = strings.TrimSuffix(user, ".atom")
	}
	if user == "" || !githubUserPattern.MatchString(user) {
		return ""
	}
	if _, reserved := reservedPaths[strings.ToLower(user)]; reserved {
		return ""
	}
	return user
}
