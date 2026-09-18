//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/pkg/snowflake"
)

// MCPServerRepository MCP 连接（16 批）。建表不塞 KV：有连接状态 / 错误 / 计数，要被建源向导遍历与引用。
type MCPServerRepository interface {
	List(ctx context.Context) ([]model.MCPServer, error)
	GetByID(ctx context.Context, id int64) (model.MCPServer, error)
	Create(ctx context.Context, server model.MCPServer) (model.MCPServer, error)
	Update(ctx context.Context, server model.MCPServer) (model.MCPServer, error)
	Delete(ctx context.Context, id int64) error
	// UpdateStatus 只更新「连接状态」那一组字段（测试 / 取数后回写），不动配置。
	UpdateStatus(ctx context.Context, id int64, connected bool, lastError *string, toolCount, resourceCount int) error
	// TouchLastUsed 记一次「这个连接刚被用过」（建源向导 / 刷新时调用）。
	TouchLastUsed(ctx context.Context, id int64) error
	// CountFeedsUsing 有多少条订阅在用这个连接（删连接前要拦一下）。
	CountFeedsUsing(ctx context.Context, id int64) (int, error)
}

type mcpServerRepository struct {
	db dbtx
}

func NewMCPServerRepository(db dbtx) MCPServerRepository {
	return &mcpServerRepository{db: db}
}

const mcpServerColumns = `id, name, transport, url, headers, auth_type, enabled, is_connected, last_error,
	tool_count, resource_count, purposes, use_global_fetch, fetch_timeout_seconds, fetch_concurrency,
	refresh_interval_minutes, last_used_at, created_at, updated_at`

func (r *mcpServerRepository) List(ctx context.Context) ([]model.MCPServer, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+mcpServerColumns+` FROM mcp_servers ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list mcp servers: %w", err)
	}
	defer rows.Close()

	var servers []model.MCPServer
	for rows.Next() {
		server, err := scanMCPServer(rows)
		if err != nil {
			return nil, err
		}
		servers = append(servers, server)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mcp servers: %w", err)
	}
	return servers, nil
}

func (r *mcpServerRepository) GetByID(ctx context.Context, id int64) (model.MCPServer, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+mcpServerColumns+` FROM mcp_servers WHERE id = ?`, id)
	return scanMCPServer(row)
}

func (r *mcpServerRepository) Create(ctx context.Context, server model.MCPServer) (model.MCPServer, error) {
	server.ID = snowflake.NextID()
	now := time.Now().UTC()
	if server.Transport == "" {
		server.Transport = model.MCPTransportStreamableHTTP
	}
	if server.AuthType == "" {
		server.AuthType = model.MCPAuthNone
	}
	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO mcp_servers (id, name, transport, url, headers, auth_type, enabled, is_connected, last_error,
			tool_count, resource_count, purposes, use_global_fetch, fetch_timeout_seconds, fetch_concurrency,
			refresh_interval_minutes, last_used_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		server.ID,
		server.Name,
		server.Transport,
		server.URL,
		marshalHeaders(server.Headers),
		server.AuthType,
		boolToInt(server.Enabled),
		boolToInt(server.IsConnected),
		nullableString(server.LastError),
		server.ToolCount,
		server.ResourceCount,
		strings.Join(server.Purposes, ","),
		boolToInt(server.UseGlobalFetch),
		nullableIntPtr(server.FetchTimeoutSeconds),
		nullableIntPtr(server.FetchConcurrency),
		nullableIntPtr(server.RefreshIntervalMinutes),
		nullableTime(server.LastUsedAt),
		formatTime(now),
		formatTime(now),
	)
	if err != nil {
		return model.MCPServer{}, fmt.Errorf("create mcp server: %w", err)
	}
	server.CreatedAt = now
	server.UpdatedAt = now
	return server, nil
}

func (r *mcpServerRepository) Update(ctx context.Context, server model.MCPServer) (model.MCPServer, error) {
	now := time.Now().UTC()
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE mcp_servers SET name = ?, transport = ?, url = ?, headers = ?, auth_type = ?, enabled = ?,
			purposes = ?, use_global_fetch = ?, fetch_timeout_seconds = ?, fetch_concurrency = ?,
			refresh_interval_minutes = ?, updated_at = ? WHERE id = ?`,
		server.Name,
		server.Transport,
		server.URL,
		marshalHeaders(server.Headers),
		server.AuthType,
		boolToInt(server.Enabled),
		strings.Join(server.Purposes, ","),
		boolToInt(server.UseGlobalFetch),
		nullableIntPtr(server.FetchTimeoutSeconds),
		nullableIntPtr(server.FetchConcurrency),
		nullableIntPtr(server.RefreshIntervalMinutes),
		formatTime(now),
		server.ID,
	)
	if err != nil {
		return model.MCPServer{}, fmt.Errorf("update mcp server: %w", err)
	}
	server.UpdatedAt = now
	return server, nil
}

func (r *mcpServerRepository) Delete(ctx context.Context, id int64) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM mcp_servers WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete mcp server: %w", err)
	}
	return nil
}

func (r *mcpServerRepository) UpdateStatus(ctx context.Context, id int64, connected bool, lastError *string, toolCount, resourceCount int) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE mcp_servers SET is_connected = ?, last_error = ?, tool_count = ?, resource_count = ?, updated_at = ? WHERE id = ?`,
		boolToInt(connected),
		nullableString(lastError),
		toolCount,
		resourceCount,
		formatTime(time.Now()),
		id,
	)
	if err != nil {
		return fmt.Errorf("update mcp server status: %w", err)
	}
	return nil
}

func (r *mcpServerRepository) TouchLastUsed(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE mcp_servers SET last_used_at = ? WHERE id = ?`,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *mcpServerRepository) CountFeedsUsing(ctx context.Context, id int64) (int, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT mcp_config FROM feeds WHERE source_type = ? AND mcp_config IS NOT NULL`, model.FeedSourceMCP)
	if err != nil {
		return 0, fmt.Errorf("count feeds using mcp server: %w", err)
	}
	defer rows.Close()

	want := strconv.FormatInt(id, 10)
	count := 0
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return 0, err
		}
		// 真解析 JSON，不做字符串匹配：serverId 可能是字符串（新写法，前端大整数安全）
		// 也可能是数字（老写法），两种都要认。
		// 必须 UseNumber：雪花 id 超过 2^53，解成 float64 会丢精度（正是我们要防的那类 bug）。
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.UseNumber()
		var probe struct {
			ServerID any `json:"serverId"`
		}
		if err := decoder.Decode(&probe); err != nil {
			continue
		}
		switch value := probe.ServerID.(type) {
		case string:
			if strings.TrimSpace(value) == want {
				count++
			}
		case json.Number:
			if value.String() == want {
				count++
			}
		}
	}
	return count, rows.Err()
}

func scanMCPServer(scanner interface {
	Scan(dest ...interface{}) error
}) (model.MCPServer, error) {
	var server model.MCPServer
	var headers sql.NullString
	var lastError sql.NullString
	var purposes sql.NullString
	var enabled, connected, useGlobalFetch sql.NullInt64
	var timeout, concurrency, interval sql.NullInt64
	var lastUsedAt sql.NullString
	var createdAt, updatedAt string
	if err := scanner.Scan(
		&server.ID,
		&server.Name,
		&server.Transport,
		&server.URL,
		&headers,
		&server.AuthType,
		&enabled,
		&connected,
		&lastError,
		&server.ToolCount,
		&server.ResourceCount,
		&purposes,
		&useGlobalFetch,
		&timeout,
		&concurrency,
		&interval,
		&lastUsedAt,
		&createdAt,
		&updatedAt,
	); err != nil {
		return model.MCPServer{}, err
	}
	server.Headers = unmarshalHeaders(headers)
	server.Enabled = enabled.Valid && enabled.Int64 != 0
	server.IsConnected = connected.Valid && connected.Int64 != 0
	// 取数时机：默认跟全局（列默认值 1）
	server.UseGlobalFetch = !useGlobalFetch.Valid || useGlobalFetch.Int64 != 0
	if lastError.Valid {
		server.LastError = &lastError.String
	}
	if purposes.Valid && purposes.String != "" {
		server.Purposes = strings.Split(purposes.String, ",")
	}
	if timeout.Valid {
		value := int(timeout.Int64)
		server.FetchTimeoutSeconds = &value
	}
	if concurrency.Valid {
		value := int(concurrency.Int64)
		server.FetchConcurrency = &value
	}
	if interval.Valid {
		value := int(interval.Int64)
		server.RefreshIntervalMinutes = &value
	}
	if lastUsedAt.Valid && lastUsedAt.String != "" {
		if t, err := parseTime(lastUsedAt.String); err == nil {
			server.LastUsedAt = &t
		}
	}
	var err error
	if server.CreatedAt, err = parseTime(createdAt); err != nil {
		return model.MCPServer{}, fmt.Errorf("parse mcp server created_at: %w", err)
	}
	if server.UpdatedAt, err = parseTime(updatedAt); err != nil {
		return model.MCPServer{}, fmt.Errorf("parse mcp server updated_at: %w", err)
	}
	return server, nil
}

func marshalHeaders(headers map[string]string) interface{} {
	if len(headers) == 0 {
		return nil
	}
	raw, err := json.Marshal(headers)
	if err != nil {
		return nil
	}
	return string(raw)
}

func unmarshalHeaders(value sql.NullString) map[string]string {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	out := map[string]string{}
	if err := json.Unmarshal([]byte(value.String), &out); err != nil {
		return nil
	}
	return out
}

// nullableIntPtr 存 *int 列（repository 里已有 boolToInt，不重复定义）。
func nullableIntPtr(value *int) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTime(value *time.Time) interface{} {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}
