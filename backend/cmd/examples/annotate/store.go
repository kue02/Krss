package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// store 是插件自己的键值数据（collection → key → 不透明字符串），对应插件页面上
// `krss.data.*` 那一组能力。外部插件不碰宿主的 DB：默认落在插件目录的 data.json
// （与 sdk 的 settings.json 并排，位置从宿主注入的 KRSS_PLUGIN_SOCKET 推出来）。
//
// 传空路径 = 只在内存里（测试用；进程退出即丢）。
type store struct {
	mu     sync.Mutex
	path   string
	loaded bool
	data   map[string]map[string]string
}

func newStore(path string) *store { return &store{path: strings.TrimSpace(path)} }

// loadLocked 首次访问时读盘；文件不存在/坏掉都当空库（插件不该因为数据文件丢了就起不来）。
func (s *store) loadLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.data = map[string]map[string]string{}
	if s.path == "" {
		return
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var stored map[string]map[string]string
	if err := json.Unmarshal(raw, &stored); err != nil || stored == nil {
		return
	}
	s.data = stored
}

// persistLocked 写穿到磁盘：先写临时文件再 rename，进程半路被杀也不会留下半截 JSON。
func (s *store) persistLocked() error {
	if s.path == "" {
		return nil
	}
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("annotate: 建数据目录失败: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("annotate: 写数据文件失败: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("annotate: 落盘失败: %w", err)
	}
	return nil
}

func (s *store) Get(collection, key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	value, ok := s.data[collection][key]
	return value, ok
}

func (s *store) Set(collection, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	if s.data[collection] == nil {
		s.data[collection] = map[string]string{}
	}
	s.data[collection][key] = value
	return s.persistLocked()
}

// List 返回该 collection 的一份拷贝（调用方随便改，不影响库里）。
func (s *store) List(collection string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	out := make(map[string]string, len(s.data[collection]))
	for key, value := range s.data[collection] {
		out[key] = value
	}
	return out
}

var (
	defaultStoreOnce sync.Once
	defaultStoreVal  *store
)

// dataStore 进程默认 store：惰性定位到插件目录下的 data.json。
// （惰性是因为 sdk.Serve 之前 main 就拿不到 socket 路径；测试永远不碰它。）
func dataStore() *store {
	defaultStoreOnce.Do(func() {
		path := ""
		if socket := strings.TrimSpace(os.Getenv("KRSS_PLUGIN_SOCKET")); socket != "" {
			path = filepath.Join(filepath.Dir(socket), "data.json")
		}
		defaultStoreVal = newStore(path)
	})
	return defaultStoreVal
}
