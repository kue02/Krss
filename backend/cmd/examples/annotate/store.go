package main

import (
	"context"
	"sync"

	"krss/backend/internal/plugin/sdk"
)

// store 插件自己的键值数据（collection → key → 不透明字符串）。
//
// **单库**：生产走宿主的 plugin_data 表（经 sdk.Data 调 /api/plugins/<自己>/data/*）。
// 这样插件进程和它的沙箱页面（页面走 bridge → 宿主同一张表）看到的是同一份数据。
// 早先版本把标注写在插件目录的 data.json、页面读宿主库，两边不通（56-32 改成单库）。
//
// 只有「单独把插件跑起来做冒烟」（没有宿主注入的 KRSS_PLUGIN_API/TOKEN/ID）时退回进程内内存；
// 单元测试也走这条路。
type store struct {
	data *sdk.Data

	mu  sync.Mutex
	mem map[string]map[string]string
}

func newStore() *store {
	return &store{data: sdk.NewData(), mem: map[string]map[string]string{}}
}

// Get 读一个值；不存在或宿主报错都回 ("", false)。写路径会把错误抛给调用方（Set）。
func (s *store) Get(collection, key string) (string, bool) {
	if s.data.Usable() {
		value, ok, err := s.data.Get(context.Background(), collection, key)
		if err != nil {
			return "", false
		}
		return value, ok
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.mem[collection]
	if !ok {
		return "", false
	}
	value, ok := bucket[key]
	return value, ok
}

// Set 写一个值。生产写宿主库，失败真的报错（不静默丢数据）。
func (s *store) Set(collection, key, value string) error {
	if s.data.Usable() {
		return s.data.Put(context.Background(), collection, key, value)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.mem[collection]
	if !ok {
		bucket = map[string]string{}
		s.mem[collection] = bucket
	}
	bucket[key] = value
	return nil
}

// List 列一个 collection；宿主报错时回空 map（读路径不该把整条动作打挂）。
func (s *store) List(collection string) map[string]string {
	if s.data.Usable() {
		values, err := s.data.List(context.Background(), collection, "")
		if err != nil || values == nil {
			return map[string]string{}
		}
		return values
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.mem[collection]))
	for key, value := range s.mem[collection] {
		out[key] = value
	}
	return out
}

var (
	defaultStoreOnce sync.Once
	defaultStoreVal  *store
)

// dataStore 进程默认 store（惰性：sdk.Serve 之前 main 还没读到宿主注入的 env）。
func dataStore() *store {
	defaultStoreOnce.Do(func() {
		defaultStoreVal = newStore()
	})
	return defaultStoreVal
}
