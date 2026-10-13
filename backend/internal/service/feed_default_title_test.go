package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// 第五十二批 52-2：抓不到 feed 标题时的**默认可读名**。
// 用户报的现象是「添加订阅没填名称 → 名称变成整条 URL」，取证结论（todo §2.52）：
// 正常抓到 feed 名的路径没问题，出问题的是「抓取失败」与「feed 自身无 title」两条兜底分支。
func TestFallbackFeedTitle(t *testing.T) {
	cases := []struct {
		name    string
		feedURL string
		siteURL string
		want    string
	}{
		{
			name:    "RSSHub telegram 路由反解到 t.me",
			feedURL: "https://rsshub.wxhdj.xyz/telegram/channel/ShadowrocketNews",
			siteURL: "",
			want:    "t.me/ShadowrocketNews",
		},
		{
			name:    "RSSHub twitter 路由反解到 x.com",
			feedURL: "https://rsshub.example.com/twitter/user/op7418",
			siteURL: "",
			want:    "x.com/op7418",
		},
		{
			// 命名空间只用来判断「这是不是聚合实例」，不参与选哪一段当名字。
			// （第一版实现误取了 segments[1]，同实例的多条源会撞成同一个名字 —— 实测抓到）
			name:    "已知命名空间但路由认不出来：实例域名 + 最后一段",
			feedURL: "https://rsshub.example.com/weibo/keyword/promo",
			siteURL: "",
			want:    "rsshub.example.com/promo",
		},
		{
			name:    "有主站地址时用主站域名 + 主页路径",
			feedURL: "https://rsshub.example.com/telegram/channel/Foo",
			siteURL: "https://t.me/s/Foo",
			want:    "t.me/s/Foo",
		},
		{
			name:    "普通博客：主站域名（去 www，feed 文件后缀不进名字）",
			feedURL: "https://www.appinn.com/feed/",
			siteURL: "https://www.appinn.com/",
			want:    "appinn.com",
		},
		{
			name:    "主站带路径时保留可读尾段",
			feedURL: "https://example.com/blog/rss.xml",
			siteURL: "https://example.com/blog",
			want:    "example.com/blog",
		},
		{
			name:    "同实例不同路由要分得开（尾段不同）",
			feedURL: "https://rsshub.example.com/github/releases/AmintaCCCP/GithubStarsManager",
			siteURL: "",
			want:    "rsshub.example.com/GithubStarsManager",
		},
		{
			name:    "非法地址不至于给出空名",
			feedURL: "not a url at all",
			siteURL: "",
			want:    "not a url at all",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := fallbackFeedTitle(tc.feedURL, tc.siteURL)
			assert.Equal(t, tc.want, got)
			if tc.feedURL != "not a url at all" {
				assert.NotEqual(t, tc.feedURL, got, "默认名不该原样等于订阅地址")
			}
		})
	}
}

func TestFallbackFeedTitleLengthClamp(t *testing.T) {
	long := "https://rsshub.example.com/telegram/channel/" + strings.Repeat("x", 200)
	got := fallbackFeedTitle(long, "")
	assert.LessOrEqual(t, len([]rune(got)), 80)
	assert.NotEmpty(t, got)
}

