package repository

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// 智能代理的域记忆（50 批 2.2 · 迁移 29）。
//
// 智能模式 = 「先直连，不通走代理」。没有记忆的话，每个不通的源**每一轮抓取**都要先白等一次
// 直连超时；把结论按目标域落库（direct / proxy），下次同域直接走记住的那条。
// 只记结论不记时间窗 —— 直连哪天恢复，清空记忆（或手动把该层改回智能）即可重来。

type ProxyDomainMemory struct {
	Host      string
	Mode      string // "direct" | "proxy"
	UpdatedAt time.Time
}

type ProxyDomainMemoryRepository interface {
	// Get 查一个域的记忆；没有记过返回 nil, nil。
	Get(ctx context.Context, host string) (*ProxyDomainMemory, error)
	// Set 记一个域的结论（upsert）。
	Set(ctx context.Context, host, mode string) error
	// List 全量（设置页展示）。
	List(ctx context.Context) ([]ProxyDomainMemory, error)
	// Clear 清空全部记忆（网络页入口）；返回清掉的条数。
	Clear(ctx context.Context) (int64, error)
}

type proxyDomainMemoryRepository struct {
	db *sql.DB
}

func NewProxyDomainMemoryRepository(db *sql.DB) ProxyDomainMemoryRepository {
	return &proxyDomainMemoryRepository{db: db}
}

func (r *proxyDomainMemoryRepository) Get(ctx context.Context, host string) (*ProxyDomainMemory, error) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil, nil
	}
	row := r.db.QueryRowContext(ctx, `SELECT host, mode, updated_at FROM proxy_domain_memory WHERE host = ?`, host)
	var m ProxyDomainMemory
	var raw string
	if err := row.Scan(&m.Host, &m.Mode, &raw); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		m.UpdatedAt = t
	}
	return &m, nil
}

func (r *proxyDomainMemoryRepository) Set(ctx context.Context, host, mode string) error {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || (mode != "direct" && mode != "proxy") {
		return nil
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO proxy_domain_memory (host, mode, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(host) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
	`, host, mode, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (r *proxyDomainMemoryRepository) List(ctx context.Context) ([]ProxyDomainMemory, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT host, mode, updated_at FROM proxy_domain_memory ORDER BY host`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProxyDomainMemory
	for rows.Next() {
		var m ProxyDomainMemory
		var raw string
		if err := rows.Scan(&m.Host, &m.Mode, &raw); err != nil {
			return nil, err
		}
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			m.UpdatedAt = t
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (r *proxyDomainMemoryRepository) Clear(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM proxy_domain_memory`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
