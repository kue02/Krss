package repository

import (
	"context"
	"database/sql"
	"time"
)

// PluginState 一个插件的启停记录（迁移 31 的 plugins 表）。
type PluginState struct {
	ID          string
	Enabled     bool
	InstalledAt time.Time
	UpdatedAt   time.Time
}

type PluginRepository interface {
	// List 全部记录（service 用来装载启停 + 发现「表里有没有」）。
	List(ctx context.Context) ([]PluginState, error)
	// Upsert 插入或更新一个插件的启停（EnsureBuiltin / PATCH 共用）。
	Upsert(ctx context.Context, id string, enabled bool) error
}

type pluginRepository struct {
	db *sql.DB
}

func NewPluginRepository(db *sql.DB) PluginRepository {
	return &pluginRepository{db: db}
}

func (r *pluginRepository) List(ctx context.Context) ([]PluginState, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id, enabled, installed_at, updated_at FROM plugins ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PluginState
	for rows.Next() {
		var p PluginState
		var enabled int
		var installedAt, updatedAt string
		if err := rows.Scan(&p.ID, &enabled, &installedAt, &updatedAt); err != nil {
			return nil, err
		}
		p.Enabled = enabled != 0
		p.InstalledAt, _ = time.Parse(time.RFC3339, installedAt)
		p.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *pluginRepository) Upsert(ctx context.Context, id string, enabled bool) error {
	now := time.Now().UTC().Format(time.RFC3339)
	on := 0
	if enabled {
		on = 1
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO plugins (id, enabled, installed_at, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
	`, id, on, now, now)
	return err
}
