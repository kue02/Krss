package githubavatar_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin/builtin/githubavatar"
)

func strPtr(v string) *string { return &v }

func TestPlugin_FeedIcon(t *testing.T) {
	p := githubavatar.Plugin{}

	cases := []struct {
		name    string
		feedURL string
		siteURL *string
		want    string
	}{
		{"用户 atom", "https://github.com/alice.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"repo releases", "https://github.com/alice/repo/releases.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"commits 分支", "https://github.com/alice/repo/commits/main.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"tags", "https://github.com/alice/repo/tags.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"discussions", "https://github.com/alice/repo/discussions.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"带 query", "https://github.com/alice.atom?foo=bar&x=1", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"带 fragment", "https://github.com/alice.atom#frag", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"host 大小写", "https://GitHub.com/alice.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"www host", "https://www.github.com/alice.atom", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"带尾斜杠", "https://github.com/alice.atom/", nil, "https://avatars.githubusercontent.com/alice?s=120"},
		{"非 github 域名", "https://example.com/alice.atom", nil, ""},
		{"保留名", "https://github.com/topics.atom", nil, ""},
		{"保留名 repo 形态", "https://github.com/features/repo/releases.atom", nil, ""},
		{"无 .atom", "https://github.com/alice", nil, ""},
		{"无 .atom 带斜杠", "https://github.com/alice/repo/", nil, ""},
		{"账号名非法", "https://github.com/invalid_user.atom", nil, ""},
		{"空串", "", nil, ""},
		{"siteURL 兜底", "https://example.com/not-github", strPtr("https://github.com/bob.atom"), "https://avatars.githubusercontent.com/bob?s=120"},
		{"feed URL 优先", "https://github.com/alice.atom", strPtr("https://github.com/bob.atom"), "https://avatars.githubusercontent.com/alice?s=120"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			feed := model.Feed{URL: tc.feedURL, SiteURL: tc.siteURL}
			got, err := p.FeedIcon(context.Background(), feed)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestPlugin_Meta(t *testing.T) {
	p := githubavatar.Plugin{}
	meta := p.Meta()
	require.Equal(t, "githubavatar", meta.ID)
	require.Equal(t, "githubavatar", p.ID())
	require.True(t, meta.Builtin)
	require.Nil(t, meta.DefaultEnabled, "默认启用")
}
