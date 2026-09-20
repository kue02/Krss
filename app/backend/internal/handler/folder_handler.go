package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

type FolderHandler struct {
	service service.FolderService
	// proxySources 解析「这个文件夹实际用哪套代理」（14 批）；nil 时响应里不带 effective
	proxySources service.ProxySourceService
}

type folderRequest struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
	Type     string  `json:"type"`
}

type updateFolderTypeRequest struct {
	Type string `json:"type"`
}

type deleteFoldersRequest struct {
	IDs []string `json:"ids"`
}

type folderResponse struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	ParentID  *string `json:"parentId,omitempty"`
	Type      string  `json:"type"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	// 代理覆盖（14 批）：inherit = 跟随父级文件夹链 → 全局；proxy / direct 是本层自己选的
	ProxyMode string `json:"proxyMode"`
	// ProxyConfig：本层单独指定的一套代理（密码已掩码）；缺省 = 用全局那套
	ProxyConfig *model.ProxyOverrideConfig `json:"proxyConfig,omitempty"`
}

// folderProxyResponse PATCH /folders/:id/proxy 的回显：文件夹本体 + 本层实际生效的结果。
type folderProxyResponse struct {
	Folder    folderResponse         `json:"folder"`
	Effective service.ProxyEffective `json:"effective"`
}

// NewFolderHandler 第二个参数可选：装上「按来源取代理」的解析器后，PATCH proxy 的回显里带实际生效结果。
func NewFolderHandler(service service.FolderService, proxySources ...service.ProxySourceService) *FolderHandler {
	handler := &FolderHandler{service: service}
	if len(proxySources) > 0 {
		handler.proxySources = proxySources[0]
	}
	return handler
}

func (h *FolderHandler) RegisterRoutes(g *echo.Group) {
	g.POST("/folders", h.Create)
	g.GET("/folders", h.List)
	g.PUT("/folders/:id", h.Update)
	g.PATCH("/folders/:id/type", h.UpdateType)
	g.PATCH("/folders/:id/proxy", h.UpdateProxyOverride)
	g.DELETE("/folders/:id", h.Delete)
	g.DELETE("/folders", h.DeleteBatch)
}

// UpdateProxyOverride 单独设置某个文件夹的代理覆盖（14 批）：跟随父级 / 走代理 / 直连。
// 子文件夹与它下面的订阅都跟着变（父级链就近覆盖）。
//
// @Summary Update folder proxy override
// @Description Per-folder proxy override (inherit / proxy / direct) with optional dedicated proxy config
// @Tags folders
// @Accept json
// @Param id path int true "Folder ID"
// @Param request body proxyOverrideRequest true "Proxy override"
// @Success 200 {object} folderProxyResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /api/folders/{id}/proxy [patch]
func (h *FolderHandler) UpdateProxyOverride(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req proxyOverrideRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	update, err := parseProxyOverrideUpdate(req)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	ctx := c.Request().Context()
	folder, err := h.service.UpdateProxyOverride(ctx, id, update)
	if err != nil {
		logger.Error("folder proxy override update failed", "module", "handler", "action", "update", "resource", "proxy", "result", "failed", "folder_id", id, "error", err)
		return writeServiceError(c, err)
	}
	effective := h.proxySources.ResolveForFolder(ctx, folder.ID)
	logger.Info("folder proxy override updated", "module", "handler", "action", "update", "resource", "proxy", "result", "ok", "folder_id", folder.ID, "mode", effective.Mode, "source", effective.Source)
	return c.JSON(http.StatusOK, folderProxyResponse{Folder: toFolderResponse(folder), Effective: effective})
}

// Create creates a new folder.
// @Summary Create a folder
// @Description Create a new folder to organize feeds
// @Tags folders
// @Accept json
// @Produce json
// @Param folder body folderRequest true "Folder creation request"
// @Success 201 Created {object} folderResponse
// @Failure 400 {object} errorResponse
// @Router /folders [post]
func (h *FolderHandler) Create(c echo.Context) error {
	var req folderRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var parentID *int64
	if req.ParentID != nil {
		id, err := strconv.ParseInt(*req.ParentID, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid parent ID"})
		}
		parentID = &id
	}
	folderType := req.Type
	if folderType == "" {
		folderType = "article"
	} else if !isValidContentType(folderType) {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "type must be article, picture, notification, or social"})
	}
	folder, err := h.service.Create(c.Request().Context(), req.Name, parentID, folderType)
	if err != nil {
		logger.Error("folder create failed", "module", "handler", "action", "create", "resource", "folder", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("folder created", "module", "handler", "action", "create", "resource", "folder", "result", "ok", "folder_id", folder.ID)
	return c.JSON(http.StatusCreated, toFolderResponse(folder))
}

// List returns all folders.
// @Summary List folders
// @Description Get a list of all folders
// @Tags folders
// @Produce json
// @Success 200 {array} folderResponse
// @Router /folders [get]
func (h *FolderHandler) List(c echo.Context) error {
	folders, err := h.service.List(c.Request().Context())
	if err != nil {
		logger.Error("folder list failed", "module", "handler", "action", "list", "resource", "folder", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}
	response := make([]folderResponse, 0, len(folders))
	for _, folder := range folders {
		response = append(response, toFolderResponse(folder))
	}
	return c.JSON(http.StatusOK, response)
}

// Update updates an existing folder.
// @Summary Update a folder
// @Description Update the name or parent ID of an existing folder
// @Tags folders
// @Accept json
// @Produce json
// @Param id path int true "Folder ID"
// @Param folder body folderRequest true "Folder update request"
// @Success 200 {object} folderResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /folders/{id} [put]
func (h *FolderHandler) Update(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req folderRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var parentID *int64
	if req.ParentID != nil {
		pid, err := strconv.ParseInt(*req.ParentID, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid parent ID"})
		}
		parentID = &pid
	}
	folder, err := h.service.Update(c.Request().Context(), id, req.Name, parentID)
	if err != nil {
		logger.Error("folder update failed", "module", "handler", "action", "update", "resource", "folder", "result", "failed", "folder_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("folder updated", "module", "handler", "action", "update", "resource", "folder", "result", "ok", "folder_id", folder.ID)
	return c.JSON(http.StatusOK, toFolderResponse(folder))
}

// UpdateType updates the content type of a folder.
// @Summary Update folder type
// @Description Change the content type of a folder (article/picture/notification/social)
// @Tags folders
// @Accept json
// @Param id path int true "Folder ID"
// @Param request body updateFolderTypeRequest true "Type update request"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /folders/{id}/type [patch]
func (h *FolderHandler) UpdateType(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req updateFolderTypeRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if !isValidContentType(req.Type) {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "type must be article, picture, notification, or social"})
	}
	if err := h.service.UpdateType(c.Request().Context(), id, req.Type); err != nil {
		logger.Error("folder update type failed", "module", "handler", "action", "update", "resource", "folder", "result", "failed", "folder_id", id, "type", req.Type, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("folder type updated", "module", "handler", "action", "update", "resource", "folder", "result", "ok", "folder_id", id, "type", req.Type)
	return c.NoContent(http.StatusNoContent)
}

// Delete deletes a folder.
// @Summary Delete a folder
// @Description Delete an existing folder
// @Tags folders
// @Param id path int true "Folder ID"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /folders/{id} [delete]
func (h *FolderHandler) Delete(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if err := h.service.Delete(c.Request().Context(), id); err != nil {
		logger.Error("folder delete failed", "module", "handler", "action", "delete", "resource", "folder", "result", "failed", "folder_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("folder deleted", "module", "handler", "action", "delete", "resource", "folder", "result", "ok", "folder_id", id)
	return c.NoContent(http.StatusNoContent)
}

// DeleteBatch deletes multiple folders.
// @Summary Delete multiple folders
// @Description Delete multiple folders at once (also deletes feeds in them)
// @Tags folders
// @Accept json
// @Param request body deleteFoldersRequest true "Folder IDs to delete"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Router /folders [delete]
func (h *FolderHandler) DeleteBatch(c echo.Context) error {
	var req deleteFoldersRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if len(req.IDs) == 0 {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "no folder IDs provided"})
	}

	for _, idStr := range req.IDs {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid folder ID"})
		}
		if err := h.service.Delete(c.Request().Context(), id); err != nil {
			logger.Error("folder batch delete failed", "module", "handler", "action", "delete", "resource", "folder", "result", "failed", "folder_id", id, "error", err)
			return writeServiceError(c, err)
		}
	}

	logger.Info("folder batch deleted", "module", "handler", "action", "delete", "resource", "folder", "result", "ok", "count", len(req.IDs))
	return c.NoContent(http.StatusNoContent)
}

func toFolderResponse(folder model.Folder) folderResponse {
	return folderResponse{
		ID:          idToString(folder.ID),
		Name:        folder.Name,
		ParentID:    idPtrToString(folder.ParentID),
		Type:        folder.Type,
		CreatedAt:   folder.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:   folder.UpdatedAt.UTC().Format(time.RFC3339),
		ProxyMode:   service.ProxyModeToString(folder.ProxyMode),
		ProxyConfig: toProxyConfigResponse(folder.ProxyConfig),
	}
}
