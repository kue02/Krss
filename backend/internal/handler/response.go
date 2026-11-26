package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

// idToString converts an int64 ID to string for JSON serialization.
// This is necessary because JavaScript cannot safely handle integers
// larger than 2^53-1, and Snowflake IDs exceed this limit.
func idToString(id int64) string {
	return strconv.FormatInt(id, 10)
}

// idPtrToString converts a *int64 ID to *string for JSON serialization.
func idPtrToString(id *int64) *string {
	if id == nil {
		return nil
	}
	s := strconv.FormatInt(*id, 10)
	return &s
}

type errorResponse struct {
	Error string `json:"error"`
}

type importStartedResponse struct {
	Status string `json:"status"`
}

type importCancelledResponse struct {
	Cancelled bool `json:"cancelled"`
}

type importIdleResponse struct {
	Status string `json:"status"`
}

func writeServiceError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, service.ErrInvalid):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	case errors.Is(err, service.ErrNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "resource not found"})
	case errors.Is(err, service.ErrConflict):
		return c.JSON(http.StatusConflict, errorResponse{Error: "conflict"})
	case errors.Is(err, service.ErrFeedFetch):
		return c.JSON(http.StatusBadGateway, errorResponse{Error: "feed fetch failed"})
	// 检查自身更新时请求 GitHub 失败（网络/限流/响应异常）—— 网关类故障，502。
	// 限流与「仓库/Release 不存在」要排在它前面：它们也 wrap 了 ErrUpdateCheckFailed，
	// 但给用户的排查方向完全不同（一个是等会儿再试，一个是仓库配错了）。
	case errors.Is(err, service.ErrUpdateRateLimited):
		return c.JSON(http.StatusTooManyRequests, errorResponse{Error: "update check rate limited"})
	// 仓库或 Release 不存在 → 404：前端按状态码就能分清「等会儿再试」和「配置有问题」，
	// 不必去匹配错误文案（文案一改，前端会静默退回通用提示且两边都不报错）。
	case errors.Is(err, service.ErrUpdateReleaseNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "update release not found"})
	case errors.Is(err, service.ErrUpdateCheckFailed):
		return c.JSON(http.StatusBadGateway, errorResponse{Error: "update check failed"})
	case errors.Is(err, service.ErrPluginNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "plugin not found"})
	case errors.Is(err, service.ErrPluginDisabled):
		return c.JSON(http.StatusConflict, errorResponse{Error: "plugin disabled"})
	// 卸载内置插件：409 + 一句能给用户看的中文口径（只能停用）。
	case errors.Is(err, service.ErrPluginBuiltinCannotUninstall):
		return c.JSON(http.StatusConflict, errorResponse{Error: err.Error()})
	// 插件包上传：包结构/manifest 不合法回 400，同名已安装回 409（透出具体原因，用户能照着改）。
	case errors.Is(err, service.ErrPluginPackageInvalid):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	case errors.Is(err, service.ErrPluginPackageExists):
		return c.JSON(http.StatusConflict, errorResponse{Error: err.Error()})
	case errors.Is(err, service.ErrPluginActionNotTestable):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "plugin action not testable"})
	// 56-18 配额：每插件数据键到顶（10 万）。409 = 「状态冲突、需要你先清理」，不是请求格式错。
	case errors.Is(err, service.ErrPluginDataQuota):
		return c.JSON(http.StatusConflict, errorResponse{Error: "plugin data key quota exceeded"})
	// 56-5/56-6 界面直调：动作没装 / 没实现 Invoker / 这个挂点没声明。
	case errors.Is(err, service.ErrPluginActionNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "plugin action not found"})
	case errors.Is(err, service.ErrPluginActionNotInvokable):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "plugin action is not invokable"})
	case errors.Is(err, service.ErrPluginSurfaceUndeclared):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "plugin action is not declared for this surface"})
	default:
		logger.Error("handler internal error", "module", "handler", "action", "request", "resource", "http", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}

// Error returns a JSON error response with the given status and message
func Error(c echo.Context, status int, message string) error {
	return c.JSON(status, errorResponse{Error: message})
}
