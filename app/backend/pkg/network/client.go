package network

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Noooste/azuretls-client"
	tls "github.com/Noooste/utls"
	"golang.org/x/net/proxy"

	"gist/backend/pkg/logger"
)

// ProxyProvider provides proxy configuration.
// This interface is defined here to avoid import cycles with service package.
type ProxyProvider interface {
	GetProxyURL(ctx context.Context) string
}

// SourceProxyProvider 按来源（订阅）解析生效的代理 URL —— 代理按来源生效（用户 14 批）。
// 由 service 层实现（内部走「订阅 → 文件夹父级链 → 全局」）；这里只声明形状，避免 pkg/network 依赖业务包。
//
// 第二个返回值为 false 表示解析不出来（库里查不到等），调用方应退回 GetProxyURL() 的老行为。
// 注意：实现必须**每轮现读**，这里不做任何缓存 —— 改完设置要立刻生效。
type SourceProxyProvider interface {
	ProxyURLForFeed(ctx context.Context, feedID int64) (string, bool)
}

// IPStackProvider provides IP stack preference.
type IPStackProvider interface {
	GetIPStack(ctx context.Context) string
}

// ClientFactory creates HTTP clients with proxy configuration.
type ClientFactory struct {
	proxyProvider   ProxyProvider
	ipStackProvider IPStackProvider
	sourceProxy     SourceProxyProvider // 按来源（订阅）取代理；nil = 老行为（只用全局那份）
	testTransport   http.RoundTripper   // For testing only
	testHTTPClient  *http.Client        // For testing only
}

// NewClientFactory creates a new client factory.
func NewClientFactory(proxyProvider ProxyProvider, ipStackProvider IPStackProvider) *ClientFactory {
	return &ClientFactory{proxyProvider: proxyProvider, ipStackProvider: ipStackProvider}
}

// WithSourceProxy 装上「按来源取代理」的解析器（链式，构造处一行搞定）。
// 刻意不缓存：每次建客户端都问一次解析器 —— 「改完设置要立刻生效」（11-20 的规矩）。
func (f *ClientFactory) WithSourceProxy(provider SourceProxyProvider) *ClientFactory {
	f.sourceProxy = provider
	return f
}

// NewClientFactoryForTest creates a client factory that uses the given http.Client for testing.
// This is only for use in tests.
func NewClientFactoryForTest(client *http.Client) *ClientFactory {
	noop := &noopProvider{}
	return &ClientFactory{
		proxyProvider:   noop,
		ipStackProvider: noop,
		testHTTPClient:  client,
	}
}

// noopProvider returns empty/default values.
type noopProvider struct{}

func (p *noopProvider) GetProxyURL(ctx context.Context) string {
	return ""
}

func (p *noopProvider) GetIPStack(ctx context.Context) string {
	return "default"
}

// NewHTTPClient creates a standard http.Client with proxy configuration.
func (f *ClientFactory) NewHTTPClient(ctx context.Context, timeout time.Duration) *http.Client {
	// For testing: return the injected client
	if f.testHTTPClient != nil {
		return f.testHTTPClient
	}

	client := &http.Client{Timeout: timeout}

	// For testing: use injected transport
	if f.testTransport != nil {
		client.Transport = f.testTransport
		return client
	}

	proxyURL := f.proxyProvider.GetProxyURL(ctx)
	ipStack := f.getIPStack(ctx)
	client.Transport = f.newTransport(proxyURL, ipStack)

	return client
}

// NewAzureSession creates an azuretls.Session with proxy configuration.
func (f *ClientFactory) NewAzureSession(ctx context.Context, timeout time.Duration) *azuretls.Session {
	session := azuretls.NewSession()
	session.Browser = azuretls.Chrome
	session.SetTimeout(timeout)
	session.ModifyConfig = useStandardCertificateVerification

	proxyURL := f.proxyProvider.GetProxyURL(ctx)
	if proxyURL != "" {
		_ = session.SetProxy(proxyURL)
	}

	return session
}

func useStandardCertificateVerification(config *tls.Config) error {
	// azuretls caches automatically discovered certificate pins globally. Those
	// pins become stale when a CDN rotates certificates, while browsers normally
	// rely on the CA chain and hostname verification instead.
	config.InsecureSkipVerify = false
	config.VerifyPeerCertificate = nil
	return nil
}

// NewHTTPClientForFeed 按来源（订阅）建客户端：先用「订阅 → 文件夹父级链 → 全局」解析出的代理，
// 解析不出来就退回全局那份（老行为）。每次现读，无缓存。
func (f *ClientFactory) NewHTTPClientForFeed(ctx context.Context, feedID int64, timeout time.Duration) *http.Client {
	// For testing: return the injected client
	if f.testHTTPClient != nil {
		return f.testHTTPClient
	}

	client := &http.Client{Timeout: timeout}
	if f.testTransport != nil {
		client.Transport = f.testTransport
		return client
	}

	client.Transport = f.newTransport(f.proxyURLForFeed(ctx, feedID), f.getIPStack(ctx))
	return client
}

// NewAzureSessionForFeed 按来源（订阅）建 azuretls 会话（正文抓取走这条）。
func (f *ClientFactory) NewAzureSessionForFeed(ctx context.Context, feedID int64, timeout time.Duration) *azuretls.Session {
	session := azuretls.NewSession()
	session.Browser = azuretls.Chrome
	session.SetTimeout(timeout)
	session.ModifyConfig = useStandardCertificateVerification

	if proxyURL := f.proxyURLForFeed(ctx, feedID); proxyURL != "" {
		_ = session.SetProxy(proxyURL)
	}

	return session
}

// proxyURLForFeed 按来源解析代理 URL；没有解析器 / 解析不出来 / feedID 非法 → 退回全局那份。
func (f *ClientFactory) proxyURLForFeed(ctx context.Context, feedID int64) string {
	if f.sourceProxy != nil && feedID > 0 {
		if proxyURL, ok := f.sourceProxy.ProxyURLForFeed(ctx, feedID); ok {
			// 解析成功时以解析结果为准：空串就是「这一条直连」，不能再回落到全局
			return proxyURL
		}
	}
	return f.proxyProvider.GetProxyURL(ctx)
}

// GetProxyURL returns the current proxy URL.
func (f *ClientFactory) GetProxyURL(ctx context.Context) string {
	return f.proxyProvider.GetProxyURL(ctx)
}

// TestProxy tests if the proxy is working by making a request to the given URL.
func (f *ClientFactory) TestProxy(ctx context.Context, testURL string) error {
	client := f.NewHTTPClient(ctx, 10*time.Second)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testURL, nil)
	if err != nil {
		return err
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return nil
}

// NewHTTPTransport creates an http.Transport with proxy configuration.
// This is useful when you need to customize the http.Client (e.g., CheckRedirect).
func (f *ClientFactory) NewHTTPTransport(ctx context.Context) *http.Transport {
	proxyURL := f.proxyProvider.GetProxyURL(ctx)
	ipStack := f.getIPStack(ctx)
	return f.newTransport(proxyURL, ipStack)
}

// TestProxyWithConfig tests a proxy configuration without saving it.
func (f *ClientFactory) TestProxyWithConfig(ctx context.Context, proxyURL, testURL string) error {
	ipStack := f.getIPStack(ctx)
	client := &http.Client{Timeout: 10 * time.Second}
	client.Transport = f.newTransport(proxyURL, ipStack)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testURL, nil)
	if err != nil {
		return err
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return nil
}

// getIPStack returns the IP stack preference, defaulting to "default".
func (f *ClientFactory) getIPStack(ctx context.Context) string {
	if f.ipStackProvider == nil {
		return "default"
	}
	return f.ipStackProvider.GetIPStack(ctx)
}

// newTransport creates an http.Transport with proxy and IP stack configuration.
func (f *ClientFactory) newTransport(proxyURL, ipStack string) *http.Transport {
	dialFunc := f.makeDialFunc(ipStack)

	if proxyURL == "" {
		return newOneShotTransport(dialFunc, nil)
	}

	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return newOneShotTransport(dialFunc, nil)
	}

	// Check if it's a SOCKS proxy
	if strings.HasPrefix(parsed.Scheme, "socks") {
		// Extract auth if present
		var auth *proxy.Auth
		if parsed.User != nil {
			auth = &proxy.Auth{
				User: parsed.User.Username(),
			}
			if password, ok := parsed.User.Password(); ok {
				auth.Password = password
			}
		}

		// Create SOCKS5 dialer with custom dial function
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, &ipStackDialer{ipStack: ipStack})
		if err != nil {
			return newOneShotTransport(dialFunc, nil)
		}

		// Create transport with SOCKS5 dialer
		return newOneShotTransport(func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.Dial(network, addr)
		}, nil)
	}

	// For HTTP/HTTPS proxies, use standard http.ProxyURL with custom dial
	return newOneShotTransport(dialFunc, http.ProxyURL(parsed))
}

func newOneShotTransport(dialContext func(ctx context.Context, network, addr string) (net.Conn, error), proxy func(*http.Request) (*url.URL, error)) *http.Transport {
	return &http.Transport{
		Proxy:             proxy,
		DialContext:       dialContext,
		DisableKeepAlives: true,
	}
}

// ipStackDialer implements proxy.Dialer for SOCKS5 with IP stack preference.
type ipStackDialer struct {
	ipStack string
}

func (d *ipStackDialer) Dial(network, addr string) (net.Conn, error) {
	return dialWithIPStack(context.Background(), network, addr, d.ipStack)
}

// makeDialFunc creates a DialContext function with IP stack preference.
func (f *ClientFactory) makeDialFunc(ipStack string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return dialWithIPStack(ctx, network, addr, ipStack)
	}
}

// dialWithIPStack dials with IP stack preference and fallback.
// - "default": uses Go's default Happy Eyeballs behavior
// - "ipv4": tries IPv4 first, falls back to IPv6 on timeout/failure
// - "ipv6": tries IPv6 first, falls back to IPv4 on timeout/failure
func dialWithIPStack(ctx context.Context, network, addr string, ipStack string) (net.Conn, error) {
	switch ipStack {
	case "ipv4":
		logger.Debug("dialing with IPv4 preference", "module", "network", "action", "dial", "resource", "network", "result", "ok", "addr", addr)
		return dialWithPreference(ctx, addr, "tcp4", "tcp6")
	case "ipv6":
		logger.Debug("dialing with IPv6 preference", "module", "network", "action", "dial", "resource", "network", "result", "ok", "addr", addr)
		return dialWithPreference(ctx, addr, "tcp6", "tcp4")
	default:
		// Happy Eyeballs - use standard Dialer
		logger.Debug("dialing with Happy Eyeballs", "module", "network", "action", "dial", "resource", "network", "result", "ok", "addr", addr)
		d := &net.Dialer{Timeout: 30 * time.Second}
		return d.DialContext(ctx, network, addr)
	}
}

// dialWithPreference tries the primary network first, then falls back to secondary.
func dialWithPreference(ctx context.Context, addr, primary, fallback string) (net.Conn, error) {
	// Try primary with 3 second timeout
	d := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, primary, addr)
	if err == nil {
		logger.Debug("dial succeeded", "module", "network", "action", "dial", "resource", "network", "result", "ok", "network", primary, "addr", addr)
		return conn, nil
	}

	// Primary failed, try fallback with longer timeout
	logger.Debug("primary dial failed, trying fallback", "module", "network", "action", "dial", "resource", "network", "result", "skipped", "primary", primary, "fallback", fallback, "addr", addr, "error", err)
	d.Timeout = 30 * time.Second
	conn, err = d.DialContext(ctx, fallback, addr)
	if err == nil {
		logger.Debug("fallback dial succeeded", "module", "network", "action", "dial", "resource", "network", "result", "ok", "network", fallback, "addr", addr)
	} else {
		logger.Debug("fallback dial failed", "module", "network", "action", "dial", "resource", "network", "result", "failed", "network", fallback, "addr", addr, "error", err)
	}
	return conn, err
}

// ExtractHost returns the host from a URL string.
func ExtractHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Host
}
