package ai

import "testing"

func TestNormalizeBaseURLIn(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		container bool
		want      string
	}{
		{"容器内 loopback 换成宿主机", "http://127.0.0.1:8000/v1", true, "http://host.docker.internal:8000/v1"},
		{"容器内 localhost 带端口", "http://localhost:11434/v1", true, "http://host.docker.internal:11434/v1"},
		{"容器内 localhost 不带端口", "http://localhost/v1", true, "http://host.docker.internal/v1"},
		{"非容器环境保持原样", "http://127.0.0.1:8000/v1", false, "http://127.0.0.1:8000/v1"},
		{"非 loopback 不动", "https://api.openai.com/v1", true, "https://api.openai.com/v1"},
		{"局域网地址不动", "http://192.0.2.1:8000/v1", true, "http://192.0.2.1:8000/v1"},
		{"空值", "", true, ""},
		{"坏地址原样返回", "not a url", true, "not a url"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeBaseURLIn(tc.raw, tc.container); got != tc.want {
				t.Fatalf("normalizeBaseURLIn(%q, %v) = %q, want %q", tc.raw, tc.container, got, tc.want)
			}
		})
	}
}
