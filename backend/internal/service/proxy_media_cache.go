package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
// 缓存 200 整段，也缓存 206 片段（<video> 的每个分片请求都带 Range，
// 原来一律跳过 ⇒ 视频永远零命中）。片段按「改写后的有界 range」做键，
// 见 mediaCacheKey 与 clampOpenEndedRange。

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
	// ContentRange 206 片段必须带上（`bytes 0-4194303/63176469`）：
	// 少了它浏览器不知道总长、也没法接着要下一段，拖进度条就坏。
	// 老缓存文件没有这个字段，反序列化得空串，正好等价于旧的 200 整段，向后兼容。
	ContentRange string `json:"contentRange,omitempty"`
}

type mediaCache struct {
	dir      string
	maxBytes int64

	mu sync.Mutex // 只用来序列化 prune，别在读写文件时长期持有
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
		ContentRange: meta.ContentRange,
		AcceptRanges: meta.AcceptRanges,
	}, true
}

// errMediaCacheEntryTooLarge 单件超过 maxCacheableMediaBytes：放弃落盘，但
// 不影响把字节继续回给客户端（缓存永远只是加速，不能变成失败原因）。
var errMediaCacheEntryTooLarge = errors.New("media cache entry too large")

func (c *mediaCache) Put(key string, result *ProxyResult) {
	if c == nil || c.dir == "" || result == nil || len(result.Data) == 0 {
		return
	}
	if int64(len(result.Data)) > maxCacheableMediaBytes {
		return
	}
	w, err := c.newWriter(key, mediaCacheMeta{
		ContentType:  result.ContentType,
		StatusCode:   result.StatusCode,
		AcceptRanges: result.AcceptRanges,
		ContentRange: result.ContentRange,
	})
	if err != nil {
		return
	}
	if _, err := w.Write(result.Data); err != nil {
		return // Write 失败时已经 Abort 掉了临时文件
	}
	w.Commit()
}

// mediaCacheWriter 缓存落盘的唯一入口：先写「meta + '\n' + 原始字节」到
// 一个 .tmp，Commit 时 rename 到正式路径，Abort 时删掉 .tmp。
//
// 为什么单独抽出来：流式转发（FetchMediaStream）是边收边写，没法等整个
// 结果到手再 Put；但落盘格式必须和 Put 完全一样，否则读回来解析不了。
// 所以格式只写在这一处，两条路共用。
type mediaCacheWriter struct {
	cache *mediaCache
	path  string
	tmp   string
	file  *os.File
	size  int64
	done  bool
}

// newWriter 建好临时文件并写入元信息头（此时还没有任何媒体字节）。
func (c *mediaCache) newWriter(key string, meta mediaCacheMeta) (*mediaCacheWriter, error) {
	if c == nil || c.dir == "" {
		return nil, errors.New("media cache disabled")
	}
	header, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	path := c.keyPath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	// 用 CreateTemp 而不是固定 `<hash>.bin.tmp`：同一个片段可能被两个播放器
	// 同时请求，固定名会互相踩掉（一个 Commit、另一个 Abort 时删错文件）。
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+"-*.tmp")
	if err != nil {
		return nil, err
	}
	w := &mediaCacheWriter{cache: c, path: path, tmp: file.Name(), file: file}
	if _, err := file.Write(append(header, '\n')); err != nil {
		w.Abort()
		return nil, err
	}
	return w, nil
}

func (w *mediaCacheWriter) Write(p []byte) (int, error) {
	if w == nil || w.done || w.file == nil {
		return 0, errors.New("media cache writer closed")
	}
	if w.size+int64(len(p)) > maxCacheableMediaBytes {
		w.Abort()
		return 0, errMediaCacheEntryTooLarge
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	if err != nil {
		w.Abort()
	}
	return n, err
}

// Commit 关文件并 rename 成正式条目；任何一步失败都当没缓存过。
func (w *mediaCacheWriter) Commit() {
	if w == nil || w.done {
		return
	}
	w.done = true
	if err := w.file.Close(); err != nil {
		_ = os.Remove(w.tmp)
		return
	}
	if err := os.Rename(w.tmp, w.path); err != nil {
		_ = os.Remove(w.tmp)
		return
	}
	w.cache.pruneIfNeeded()
}

// Abort 丢弃半截文件：客户端中途断开、上游出错、超限都用它。
func (w *mediaCacheWriter) Abort() {
	if w == nil || w.done {
		return
	}
	w.done = true
	if w.file != nil {
		_ = w.file.Close()
	}
	_ = os.Remove(w.tmp)
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
