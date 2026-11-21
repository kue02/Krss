package service

import (
	"context"

	"krss/backend/internal/plugin"
	"krss/backend/pkg/logger"
)

// 56-27 视图聚合（service 侧）。
//
// 只做一件注册表做不了的事：先把「库里说的启停」装进注册表（冷启动后前端直接要视图清单的场景），
// 再让注册表按自家人马清洗 —— 清洗规则（custom 要 ui:custom、kind 兜底、排序、注入 plugin）
// 全在 plugin.Registry.AllViews，不在这儿重复一遍（两处规则一定会漂）。

// Views 全部已启用插件注册的视图。
func (s *pluginService) Views(ctx context.Context) []plugin.View {
	// 与 Contributions 同一条口径：启停位存在库里、只有 Catalog 那条链会装载，
	// 所以「打开页面就要对」的读接口自己补一次（幂等；失败不挡读，退化成注册表默认值并留日志）。
	if s.plugins != nil {
		if err := s.ensureBuiltin(ctx); err != nil {
			logger.Warn("plugin views ensure builtin failed",
				"module", "service", "action", "views", "resource", "plugin", "result", "degraded", "error", err)
		}
	}
	s.ensureExternal(ctx)
	return s.registry.AllViews()
}
