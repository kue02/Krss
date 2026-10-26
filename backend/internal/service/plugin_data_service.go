package service

import (
	"context"
	"errors"

	"krss/backend/internal/repository"
)

// 插件专属数据（56-19）—— 插件存自己东西的地方（阅读进度、探测结果、缓存…），
// 走迁移 34 的 plugin_data 表。三件事在这里定死：
//   - 归属：只能碰自己的 plugin_id。外部插件走 socket 时 id 由宿主注入，插件填不了别人的 ⇒ 不可能越权。
//   - 启停：停用的插件不许读写（与 /settings、/invoke 同口径）。
//   - 边界：collection 名 / 键长 / 单值大小 / limit 先在 service 挡 → 400，
//     仓储那道只做兜底（那条路是 500 级别的「不该发生」）。
//
// 值是任意 JSON 字符串：本体不解析、不改写，原样存取（插件自己定 schema）。

// validatePluginDataTarget 插件在不在 + 开没开 + 数据仓储挂没挂。
func (s *pluginService) validatePluginDataTarget(pluginID string) error {
	if _, ok := s.registry.Meta(pluginID); !ok {
		return ErrPluginNotFound
	}
	if !s.registry.Enabled(pluginID) {
		return ErrPluginDisabled
	}
	if s.data == nil {
		return ErrPluginDataUnavailable
	}
	return nil
}

// validatePluginDataRef collection 名与键名（写读删共用）。
func validatePluginDataRef(collection, key string) error {
	if !repository.ValidPluginDataCollection(collection) {
		return ErrInvalid
	}
	if len(key) == 0 || len(key) > repository.PluginDataMaxKeyBytes {
		return ErrInvalid
	}
	return nil
}

// clampPluginDataLimit limit 收敛到仓储的边界（缺省 200 / 上限 1000），
// 让前端不必自己夹 —— 传 99999 不报错，只给 1000 条。
func clampPluginDataLimit(limit int) int {
	if limit <= 0 {
		return repository.PluginDataDefaultLimit
	}
	if limit > repository.PluginDataMaxLimit {
		return repository.PluginDataMaxLimit
	}
	return limit
}

// pluginDataError 仓储错误 → service 口径（404 / 400 / 原样上抛成 500）。
func pluginDataError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, repository.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, repository.ErrPluginDataInvalidCollection),
		errors.Is(err, repository.ErrPluginDataInvalidKey),
		errors.Is(err, repository.ErrPluginDataValueTooLarge):
		return ErrInvalid
	default:
		return err
	}
}

// GetData 读一个键；不存在 = ErrNotFound（404）。
func (s *pluginService) GetData(ctx context.Context, pluginID, collection, key string) (string, error) {
	if err := s.validatePluginDataTarget(pluginID); err != nil {
		return "", err
	}
	if err := validatePluginDataRef(collection, key); err != nil {
		return "", err
	}
	value, err := s.data.Get(ctx, pluginID, collection, key)
	if err != nil {
		return "", pluginDataError(err)
	}
	return value, nil
}

// PutData 写/覆盖一个键（同 (plugin, collection, key) = 覆盖）。
func (s *pluginService) PutData(ctx context.Context, pluginID, collection, key, value string) error {
	if err := s.validatePluginDataTarget(pluginID); err != nil {
		return err
	}
	if err := validatePluginDataRef(collection, key); err != nil {
		return err
	}
	if len(value) > repository.PluginDataMaxValueBytes {
		return ErrInvalid
	}
	return pluginDataError(s.data.Put(ctx, pluginID, collection, key, value))
}

// DeleteData 删一个键；键不在 = ErrNotFound（404）。
func (s *pluginService) DeleteData(ctx context.Context, pluginID, collection, key string) error {
	if err := s.validatePluginDataTarget(pluginID); err != nil {
		return err
	}
	if err := validatePluginDataRef(collection, key); err != nil {
		return err
	}
	return pluginDataError(s.data.Delete(ctx, pluginID, collection, key))
}

// ListData 列一个 collection 的键值（prefix 为空 = 全部；limit 缺省 200、上限 1000）。
func (s *pluginService) ListData(ctx context.Context, pluginID, collection, prefix string, limit int) (map[string]string, error) {
	if err := s.validatePluginDataTarget(pluginID); err != nil {
		return nil, err
	}
	if !repository.ValidPluginDataCollection(collection) {
		return nil, ErrInvalid
	}
	values, err := s.data.List(ctx, pluginID, collection, prefix, clampPluginDataLimit(limit))
	if err != nil {
		return nil, pluginDataError(err)
	}
	if values == nil {
		values = map[string]string{}
	}
	return values, nil
}

// DeleteDataCollection 删掉一个 collection 的全部键（幂等：空 collection 也照样成功）。
func (s *pluginService) DeleteDataCollection(ctx context.Context, pluginID, collection string) error {
	if err := s.validatePluginDataTarget(pluginID); err != nil {
		return err
	}
	if !repository.ValidPluginDataCollection(collection) {
		return ErrInvalid
	}
	return pluginDataError(s.data.DeleteCollection(ctx, pluginID, collection))
}
