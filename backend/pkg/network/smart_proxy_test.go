package network

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// 50 批 2.2：智能传输 —— 没记忆先直连（短探测），直连成功记 direct；
// 直连失败代理成功记 proxy；有记忆直接走记住的那条，不再探测。
type fakeMemory struct {
	mu     sync.Mutex
	store  map[string]string
	gets   int
	failed error
}

func (f *fakeMemory) MemoryModeFor(_ context.Context, host string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	if f.failed != nil {
		return "", false
	}
	mode, ok := f.store[host]
	return mode, ok
}

func (f *fakeMemory) Remember(_ context.Context, host, mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.store[host] = mode
}

func TestSmartTransport_DirectSucceedsRemembersDirect(t *testing.T) {
	var directHits, proxyHits int
	directSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		directHits++
		w.WriteHeader(200)
	}))
	defer directSrv.Close()
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxyHits++
		w.WriteHeader(200)
	}))
	defer proxySrv.Close()

	// 直接以 httptest 服务器当「腿」：直连腿可达、代理腿可达
	mem := &fakeMemory{store: map[string]string{}}
	directRT := roundTripperOf(directSrv.URL)
	proxyRT := roundTripperOf(proxySrv.URL)
	tr := NewSmartTransport(directRT, proxyRT, mem)

	req, _ := http.NewRequest(http.MethodGet, directSrv.URL, nil)
	resp, err := tr.RoundTrip(req)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	require.Equal(t, "direct", mem.store[req.URL.Hostname()], "直连成功要记 direct")
	require.Equal(t, 1, directHits)

	// 第二次：走记忆，不再探测直连（直连腿计数不再增长——这里两腿是不同服务器，
	// 记 direct 后永远打直连腿）
	resp, err = tr.RoundTrip(req)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	require.Equal(t, 2, directHits)
}

func TestSmartTransport_DirectFailsFallsBackToProxyAndRemembers(t *testing.T) {
	mem := &fakeMemory{store: map[string]string{}}
	directRT := roundTripperFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})
	proxyCalled := 0
	proxyRT := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		proxyCalled++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(nil_reader{})}, nil
	})
	tr := NewSmartTransport(directRT, proxyRT, mem)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)

	resp, err := tr.RoundTrip(req)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	require.Equal(t, 1, proxyCalled)
	require.Equal(t, "proxy", mem.store[req.URL.Hostname()])

	// 有记忆：直接走代理，直连腿不再被探测
	directRT2 := roundTripperFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, errors.New("should not be called")
	})
	tr2 := NewSmartTransport(directRT2, proxyRT, mem)
	resp, err = tr2.RoundTrip(req)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	require.Equal(t, 2, proxyCalled)
}

func TestSmartTransport_NoProxyLegDirectFailurePropagates(t *testing.T) {
	mem := &fakeMemory{store: map[string]string{}}
	directErr := errors.New("dial timeout")
	directRT := roundTripperFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, directErr
	})
	tr := NewSmartTransport(directRT, nil, mem)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	_, err := tr.RoundTrip(req)
	require.ErrorIs(t, err, directErr)
}

// roundTripperOf 打到给定 base URL 的请求直接由该服务器处理（模拟「腿」）。
func roundTripperOf(baseURL string) http.RoundTripper {
	return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		outReq, err := http.NewRequestWithContext(req.Context(), http.MethodGet, baseURL, nil)
		if err != nil {
			return nil, err
		}
		return http.DefaultTransport.RoundTrip(outReq)
	})
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type nil_reader struct{}

func (nil_reader) Read([]byte) (int, error) { return 0, io.EOF }
