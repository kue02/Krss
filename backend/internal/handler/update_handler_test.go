package handler_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/handler"
	"krss/backend/internal/service"
)

// stubUpdateService 是一个最小的 service.UpdateService 实现，供 handler 测试用。
type stubUpdateService struct {
	info *service.UpdateInfo
	err  error
}

func (s *stubUpdateService) Check(ctx context.Context) (*service.UpdateInfo, error) {
	return s.info, s.err
}

func TestUpdateHandler_Check_Success(t *testing.T) {
	e := newTestEcho()
	svc := &stubUpdateService{info: &service.UpdateInfo{
		CurrentVersion: "1.4.0",
		LatestVersion:  "v1.5.0",
		HasUpdate:      true,
		ReleaseURL:     "https://github.com/kue02/krss/releases/tag/v1.5.0",
		Assets:         []service.UpdateAsset{},
	}}
	handler.NewUpdateHandler(svc).RegisterRoutes(e.Group(""))

	req := newJSONRequest(http.MethodGet, "/update/check", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var got service.UpdateInfo
	parseJSONResponse(t, rec, &got)
	require.True(t, got.HasUpdate)
	require.Equal(t, "v1.5.0", got.LatestVersion)
}

func TestUpdateHandler_Check_FailureMapsTo502(t *testing.T) {
	e := newTestEcho()
	svc := &stubUpdateService{err: fmt.Errorf("%w: github status 500", service.ErrUpdateCheckFailed)}
	handler.NewUpdateHandler(svc).RegisterRoutes(e.Group(""))

	req := newJSONRequest(http.MethodGet, "/update/check", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadGateway, rec.Code)
	var body map[string]string
	parseJSONResponse(t, rec, &body)
	require.Equal(t, "update check failed", body["error"])
}
