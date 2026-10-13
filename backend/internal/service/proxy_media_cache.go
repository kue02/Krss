package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"krss/backend/pkg/logger"
)

// 代理媒体的磁盘缓存（50-2）。
//
// 为什么要有它：图片都要过 /api/proxy/image 出网取一遍，原来只给了
// `Cache-Control: public, max-age=86400`（浏览器缓存），**服务端一点都不留**。
// 实测同一张图连取三遍：0.708s / 0.967s / 0.669s —— 第二三遍和第一遍一样慢。
// 一篇 35 图的文章，等于把 35 次出网延迟原样叠给用户。
//
// 落盘格式：一个文件搞定 —— 第一行是 JSON 元信息，紧跟原始字节。
// 写临时文件再 rename，避免读到半截文件。
//
// 只缓存「不带 Range 的 200 整段」：<video> 拖进度条会带 Range，那种片段缓存价值低、
// 命中判断也复杂，直接透传。

const (
	// 默认缓存上限 512 MB；超过就按 mtime 从旧到新删到 80%
	defaultMediaCacheBytes = int64(512) << 20
	// 单件上限：超过这个大小的媒体（大视频）不落盘，省得把缓存挤爆
	maxCacheableMediaBytes = int64(16) << 20
)

type mediaCacheMeta struct {
	ContentType  string `json:"contentType"`
	StatusCode   int    `json:"statusCode"`
	AcceptRanges string `json:"acceptRanges,omitempty"`
}

type mediaCache struct {
	dir      string
	maxBytes int64

	mu    sync.Mutex // 只用来序列化 prune，别在读写文件时长期持有
	total int64
}

func newMediaCache(dir string, maxBytes int64) *mediaCache {
	if maxBytes <= 0 {
		maxBytes = defaultMediaCacheBytes
	}
	return &mediaCache{dir: dir, maxBytes: maxBytes}
}

func (c *mediaCache) keyPath(key string) string {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:])
	return filepath.Join(c.dir, name[:2], name+".bin")
}

// Get 命中就返回结果；任何读取异常都当作未命中（缓存不该影响可用性）。
func (c *mediaCache) Get(key string) (*ProxyResult, bool) {
	if c == nil || c.dir == "" {
		return nil, false
	}
	raw, err := os.ReadFile(c.keyPath(key))
	if err != nil {
		return nil, false
	}
	nl := indexByte(raw, '\n')
	if nl <= 0 {
		return nil, false
	}
	var meta mediaCacheMeta
	if err := json.Unmarshal(raw[:nl], &meta); err != nil {
		return nil, false
	}
	data := raw[nl+1:]
	if len(data) == 0 {
		return nil, false
	}
	// 命中时把 mtime 推新，LRU 才按「最近用过」淘汰
	_ = touchFile(c.keyPath(key))
	return &ProxyResult{
		Data:         data,
		ContentType:  meta.ContentType,
		StatusCode:   meta.StatusCode,
		AcceptRanges: meta.AcceptRanges,
	}, true
}

func (c *mediaCache) Put(key string, result *ProxyResult) {
	if c == nil || c.dir == "" || result == nil || len(result.Data) == 0 {
		return
	}
	if int64(len(result.Data)) > maxCacheableMediaBytes {
		return
	}
	meta, err := json.Marshal(mediaCacheMeta{
		ContentType:  result.ContentType,
		StatusCode:   result.StatusCode,
		AcceptRanges: result.AcceptRanges,
	})
	if err != nil {
		return
	}
	path := c.keyPath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	tmp := path + ".tmp"
	buf := make([]byte, 0, len(meta)+1+len(result.Data))
	buf = append(buf, meta...)
	buf = append(buf, '\n')
	buf = append(buf, result.Data...)
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return
	}
	c.pruneIfNeeded()
}

// pruneIfNeeded 超出上限就按 mtime 从旧到新删，直到降到 80%。
// 只在写入后跑一次，加锁避免并发写时反复全目录扫描。
func (c *mediaCache) pruneIfNeeded() {
	c.mu.Lock()
	defer c.mu.Unlock()

	type entry struct {
		path string
		size int64
		mod  int64
	}
	var entries []entry
	var total int64
	_ = filepath.Walk(c.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".tmp") {
			_ = os.Remove(path)
			return nil
		}
		entries = append(entries, entry{path: path, size: info.Size(), mod: info.ModTime().UnixNano()})
		total += info.Size()
		return nil
	})

	if total <= c.maxBytes {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].mod < entries[j].mod })
	target := c.maxBytes * 8 / 10
	removed := int64(0)
	for _, e := range entries {
		if total-removed <= target {
			break
		}
		if err := os.Remove(e.path); err == nil {
			removed += e.size
		}
	}
	logger.Info("proxy media cache pruned", "module", "service", "action", "prune", "resource", "proxy", "result", "ok",
		"removed_bytes", removed, "cap", c.maxBytes)
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}

// MediaCacheStats 给排查用（日志/测试）：文件数与总字节。
func (c *mediaCache) Stats() (files int, bytes int64) {
	if c == nil || c.dir == "" {
		return 0, 0
	}
	_ = filepath.Walk(c.dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		files++
		bytes += info.Size()
		return nil
	})
	return files, bytes
}

// touchFile 把文件的 mtime 推到当前时间（LRU 用）。
func touchFile(path string) error {
	now := time.Now()
	return os.Chtimes(path, now, now)
}
