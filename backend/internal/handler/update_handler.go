package handler

import (
	"net/http"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
)

// UpdateHandler 检查 Krss 自身是否有新版本。
type UpdateHandler struct {
	service service.UpdateService
}

func NewUpdateHandler(svc service.UpdateService) *UpdateHandler {
	return &UpdateHandler{service: svc}
}

func (h *UpdateHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/update/check", h.Check)
}

// Check godoc
// @Summary Check for Krss updates
// @Description 请求 GitHub 最新 Release，返回运行版本、最新版本、是否有更新，以及渲染好的发布说明 HTML 和可下载附件。
// @Description 限流时返回 429，仓库或 Release 不存在时返回 502，其余失败返回 502。
// @Tags update
// @Produce json
// @Success 200 {object} service.UpdateInfo
// @Failure 429 {object} errorResponse
// @Failure 502 {object} errorResponse
// @Router /api/update/check [get]
func (h *UpdateHandler) Check(c echo.Context) error {
	ctx := c.Request().Context()

	info, err := h.service.Check(ctx)
	if err != nil {
		// 失败原因（限流/仓库不存在/其它）由 service 分级记录，这里不再重复打一遍 ERROR。
		return writeServiceError(c, err)
	}

	return c.JSON(http.StatusOK, info)
}
