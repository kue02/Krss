package handler_test

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"testing"

	"krss/backend/internal/handler"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestProxyHandler_ProxyImage_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	imageURL := "https://example.com/img.png"
	refererURL := "https://example.com/article"
	encoded := base64.URLEncoding.EncodeToString([]byte(imageURL))
	refEncoded := base64.URLEncoding.EncodeToString([]byte(refererURL))

	mockService.EXPECT().
		FetchMedia(gomock.Any(), imageURL, refererURL, "").
		Return(&service.ProxyResult{Data: []byte("image-data"), ContentType: "image/png"}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded+"?ref="+refEncoded, nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	err := h.ProxyImage(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "public, max-age=86400", rec.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	require.Equal(t, "image-data", rec.Body.String())
}

func TestProxyHandler_ProxyImage_SVGSecurityHeaders(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	imageURL := "https://example.com/img.svg"
	encoded := base64.URLEncoding.EncodeToString([]byte(imageURL))
	svgData := []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)

	mockService.EXPECT().
		FetchMedia(gomock.Any(), imageURL, "", "").
		Return(&service.ProxyResult{Data: svgData, ContentType: "image/svg+xml"}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	err := h.ProxyImage(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "image/svg+xml", rec.Header().Get("Content-Type"))
	require.Equal(t, "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; sandbox", rec.Header().Get("Content-Security-Policy"))
	require.Equal(t, string(svgData), rec.Body.String())
}

func TestProxyHandler_ProxyImage_MissingEncoded(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": ""})

	err := h.ProxyImage(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestProxyHandler_ProxyImage_InvalidEncoding(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/invalid", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": "%%%invalid"})

	err := h.ProxyImage(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestProxyHandler_ProxyImage_ErrorMapping(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	imageURL := "https://example.com/img.png"
	encoded := base64.URLEncoding.EncodeToString([]byte(imageURL))

	tests := []struct {
		name           string
		err            error
		status         int
		cacheControl   string
		expectedPrefix string
	}{
		{name: "invalid_url", err: service.ErrInvalidURL, status: http.StatusBadRequest},
		{name: "invalid_protocol", err: service.ErrInvalidProtocol, status: http.StatusBadRequest},
		{name: "invalid_image", err: service.ErrInvalidImage, status: http.StatusBadGateway},
		{name: "timeout", err: service.ErrRequestTimeout, status: http.StatusGatewayTimeout},
		{name: "upstream_rejected", err: service.ErrUpstreamRejected, status: http.StatusBadGateway, cacheControl: "no-store, no-cache, must-revalidate"},
		{name: "default", err: errors.New("boom"), status: http.StatusInternalServerError},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mockService := mock.NewMockProxyService(ctrl)
			h := handler.NewProxyHandlerHelper(mockService)

			mockService.EXPECT().
				FetchMedia(gomock.Any(), imageURL, "", "").
				Return(nil, tc.err)

			e := newTestEcho()
			req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
			c, rec := newTestContext(e, req)
			setPathParams(c, map[string]string{"encoded": encoded})

			err := h.ProxyImage(c)
			require.NoError(t, err)
			require.Equal(t, tc.status, rec.Code)
			if tc.cacheControl != "" {
				require.Equal(t, tc.cacheControl, rec.Header().Get("Cache-Control"))
			}
		})
	}
}

// Range 请求必须走流式：状态码/Content-Range/Content-Length 都要透传，
// 而且 Content-Length 是 handler 手动设的（echo 的 c.Stream 不设）。
func TestProxyHandler_ProxyImage_RangeUsesStreaming(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	mediaURL := "https://example.com/v.mp4"
	encoded := base64.URLEncoding.EncodeToString([]byte(mediaURL))
	payload := []byte("chunk-bytes")

	mockService.EXPECT().
		FetchMediaStream(gomock.Any(), mediaURL, "", "bytes=0-").
		Return(&service.MediaStream{
			Body:          io.NopCloser(bytes.NewReader(payload)),
			ContentType:   "video/mp4",
			StatusCode:    http.StatusPartialContent,
			ContentRange:  "bytes 0-10/63176469",
			ContentLength: int64(len(payload)),
			AcceptRanges:  "bytes",
		}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
	req.Header.Set("Range", "bytes=0-")
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	err := h.ProxyImage(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusPartialContent, rec.Code)
	require.Equal(t, "video/mp4", rec.Header().Get("Content-Type"))
	require.Equal(t, "bytes 0-10/63176469", rec.Header().Get("Content-Range"))
	require.Equal(t, "bytes", rec.Header().Get("Accept-Ranges"))
	require.Equal(t, "11", rec.Header().Get("Content-Length"))
	require.Equal(t, "public, max-age=86400", rec.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	require.Equal(t, string(payload), rec.Body.String())
}

// 流式失败要按 service 错误映射成对应状态码，且此时还没有写任何 header。
func TestProxyHandler_ProxyImage_StreamingErrorMapping(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mediaURL := "https://example.com/v.mp4"
	encoded := base64.URLEncoding.EncodeToString([]byte(mediaURL))

	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "invalid_url", err: service.ErrInvalidURL, status: http.StatusBadRequest},
		{name: "timeout", err: service.ErrRequestTimeout, status: http.StatusGatewayTimeout},
		{name: "fetch_failed", err: service.ErrFetchFailed, status: http.StatusInternalServerError},
		{name: "range_not_satisfiable", err: service.ErrRangeNotSatisfiable, status: http.StatusRequestedRangeNotSatisfiable},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mockService := mock.NewMockProxyService(ctrl)
			h := handler.NewProxyHandlerHelper(mockService)

			mockService.EXPECT().
				FetchMediaStream(gomock.Any(), mediaURL, "", "bytes=100-").
				Return(nil, tc.err)

			e := newTestEcho()
			req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
			req.Header.Set("Range", "bytes=100-")
			c, rec := newTestContext(e, req)
			setPathParams(c, map[string]string{"encoded": encoded})

			err := h.ProxyImage(c)
			require.NoError(t, err)
			require.Equal(t, tc.status, rec.Code)
		})
	}
}

// 无 Range（图片）必须仍走缓冲路径：不能因为加了流式就把图片改道。
func TestProxyHandler_ProxyImage_NoRangeStaysBuffered(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	imageURL := "https://example.com/img.png"
	encoded := base64.URLEncoding.EncodeToString([]byte(imageURL))

	// 只期望 FetchMedia：一旦 handler 错走 FetchMediaStream，gomock 会直接失败
	mockService.EXPECT().
		FetchMedia(gomock.Any(), imageURL, "", "").
		Return(&service.ProxyResult{Data: []byte("png"), ContentType: "image/png", StatusCode: http.StatusOK}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	require.NoError(t, h.ProxyImage(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "png", rec.Body.String())
}

// 上游判定越界回 416：流式路径必须原样给 416（不能塌成 200），带 Content-Range。
func TestProxyHandler_ProxyImage_RangePassesThrough416(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	mediaURL := "https://example.com/v.mp4"
	encoded := base64.URLEncoding.EncodeToString([]byte(mediaURL))

	mockService.EXPECT().
		FetchMediaStream(gomock.Any(), mediaURL, "", "bytes=999999999-").
		Return(&service.MediaStream{
			Body:          io.NopCloser(bytes.NewReader(nil)),
			ContentType:   "text/plain; charset=utf-8",
			StatusCode:    http.StatusRequestedRangeNotSatisfiable,
			ContentRange:  "bytes */63176469",
			ContentLength: 0,
			AcceptRanges:  "bytes",
		}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
	req.Header.Set("Range", "bytes=999999999-")
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	require.NoError(t, h.ProxyImage(c))
	require.Equal(t, http.StatusRequestedRangeNotSatisfiable, rec.Code)
	require.Equal(t, "bytes */63176469", rec.Header().Get("Content-Range"))
}

// P2-1：SVG 的 CSP 在流式路径也必须设（以前只在缓冲路径设，流式漏了）。
func TestProxyHandler_ProxyImage_StreamingSVGSetsCSP(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockProxyService(ctrl)
	h := handler.NewProxyHandlerHelper(mockService)

	mediaURL := "https://example.com/icon.svg"
	encoded := base64.URLEncoding.EncodeToString([]byte(mediaURL))
	payload := []byte("<svg/>")

	mockService.EXPECT().
		FetchMediaStream(gomock.Any(), mediaURL, "", "bytes=0-").
		Return(&service.MediaStream{
			Body:          io.NopCloser(bytes.NewReader(payload)),
			ContentType:   "image/svg+xml",
			StatusCode:    http.StatusPartialContent,
			ContentRange:  "bytes 0-5/6",
			ContentLength: int64(len(payload)),
			AcceptRanges:  "bytes",
		}, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/image/"+encoded, nil)
	req.Header.Set("Range", "bytes=0-")
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"encoded": encoded})

	require.NoError(t, h.ProxyImage(c))
	require.Equal(t, http.StatusPartialContent, rec.Code)
	require.Equal(t, "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; sandbox", rec.Header().Get("Content-Security-Policy"))
}
