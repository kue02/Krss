package handler

import (
	"fmt"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
)

// maxBackupSize 上传备份文件上限。备份只含订阅与配置（不含文章正文），32MB 足够。
const maxBackupSize = 32 << 20

// BackupHandler 全量备份（整库 JSON 导出/导入）。
type BackupHandler struct {
	service service.BackupService
}

func NewBackupHandler(backupService service.BackupService) *BackupHandler {
	return &BackupHandler{service: backupService}
}

func (h *BackupHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/backup/export", h.Export)
	g.POST("/backup/import", h.Import)
}

// Export 导出整库备份
//
// @Summary Export full backup
// @Description 导出完整备份 JSON：文件夹层级+类型、全部订阅（含类型/来源/MCP 配置/覆盖项）、非敏感设置、插件启停、MCP 连接配置。凭证类不导出。
// @Tags backup
// @Produce json
// @Success 200 {string} string "backup json"
// @Failure 500 {object} errorResponse
// @Router /backup/export [get]
func (h *BackupHandler) Export(c echo.Context) error {
	payload, err := h.service.Export(c.Request().Context())
	if err != nil {
		return writeServiceError(c, err)
	}
	filename := fmt.Sprintf("krss-backup-%s.json", time.Now().Format("20060102-150405"))
	c.Response().Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	return c.Blob(http.StatusOK, "application/json", payload)
}

// Import 导入整库备份
//
// @Summary Import full backup
// @Description 接受导出文件，重建文件夹层级与订阅（含类型/归属），按 URL/名称去重；应用非敏感设置、插件启停与 MCP 连接配置。
// @Tags backup
// @Accept json
// @Produce json
// @Success 200 {object} service.BackupImportResult
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /backup/import [post]
func (h *BackupHandler) Import(c echo.Context) error {
	body := http.MaxBytesReader(c.Response(), c.Request().Body, maxBackupSize)
	result, err := h.service.Import(c.Request().Context(), body)
	if err != nil {
		return writeServiceError(c, err)
	}
	return c.JSON(http.StatusOK, result)
}
