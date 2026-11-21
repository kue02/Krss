package handler

import (
	"errors"
	"net/http"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
)

// ExportHandler 插件导出落盘（`POST /api/exports`）。
//
// 插件在自己的 Invoke 里返回 files（name + content），宿主决定写到哪：
// 设置 → 通用 → 导出目录。没配目录时回 400，前端据此回落到浏览器下载 ——
// 「能不能写盘」是用户环境的事，不该让插件自己猜路径。
type ExportHandler struct {
	service service.ExportService
}

// NewExportHandler 构造导出接口。
func NewExportHandler(svc service.ExportService) *ExportHandler {
	return &ExportHandler{service: svc}
}

// RegisterRoutes 注册导出路由。
func (h *ExportHandler) RegisterRoutes(g *echo.Group) {
	g.POST("/exports", h.ExportFiles)
}

type exportFilesRequest struct {
	Files []service.ExportFile `json:"files"`
}

type exportFilesResponse struct {
	Paths []string `json:"paths"`
}

// ExportFiles 把插件导出的一批文件写到导出目录。
//
//	@Summary	写导出文件
//	@Description	插件导出的文件落到「设置 → 通用 → 导出目录」；未配置时 400，前端回落浏览器下载
//	@Tags		exports
//	@Accept		json
//	@Produce	json
//	@Param		body	body		exportFilesRequest	true	"要写盘的文件"
//	@Success	200		{object}	exportFilesResponse
//	@Failure	400		{object}	map[string]string
//	@Security	BearerAuth
//	@Router		/exports [post]
func (h *ExportHandler) ExportFiles(c echo.Context) error {
	var req exportFilesRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request"})
	}
	paths, err := h.service.WriteFiles(c.Request().Context(), req.Files)
	if err != nil {
		if errors.Is(err, service.ErrExportDirNotSet) {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "未设置导出目录"})
		}
		return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
	return c.JSON(http.StatusOK, exportFilesResponse{Paths: paths})
}
