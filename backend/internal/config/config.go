package config

import (
	"os"
	"path/filepath"
)

const (
	AppName    = "Krss"
	AppVersion = "1.2.0"
	AppRepo    = "https://github.com/hu2327401139/Krss"
)

// KrssUserAgent identifies as Krss RSS reader
var KrssUserAgent = "Mozilla/5.0 (compatible; " + AppName + "/" + AppVersion + "; +" + AppRepo + ")"

// Chrome headers for TLS fingerprinting (must match azuretls Chrome profile version)
const (
	ChromeUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
	ChromeSecChUa   = `"Google Chrome";v="135", "Chromium";v="135", "Not-A.Brand";v="8"`
)

// DefaultUserAgent for RSS fetching
var DefaultUserAgent = KrssUserAgent

type Config struct {
	Addr          string
	DBPath        string
	DataDir       string
	StaticDir     string
	LogLevel      string
	EnableSwagger bool
	PprofAddr     string
}

func Load() Config {
	addr := os.Getenv("KRSS_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	dataDir := os.Getenv("KRSS_DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	path := os.Getenv("KRSS_DB_PATH")
	if path == "" {
		path = filepath.Join(dataDir, "krss.db")
	}
	staticDir := os.Getenv("KRSS_STATIC_DIR")
	if staticDir == "" {
		staticDir = detectStaticDir()
	}

	logLevel := os.Getenv("KRSS_LOG_LEVEL")
	if logLevel == "" {
		logLevel = "info"
	}

	enableSwagger := os.Getenv("KRSS_SWAGGER") == "true"
	pprofAddr := os.Getenv("KRSS_PPROF_ADDR")
	if os.Getenv("KRSS_ENABLE_PPROF") == "true" && pprofAddr == "" {
		pprofAddr = "127.0.0.1:6060"
	}

	return Config{
		Addr:          addr,
		DBPath:        filepath.Clean(path),
		DataDir:       filepath.Clean(dataDir),
		StaticDir:     filepath.Clean(staticDir),
		LogLevel:      logLevel,
		EnableSwagger: enableSwagger,
		PprofAddr:     pprofAddr,
	}
}

func detectStaticDir() string {
	candidates := []string{
		"./frontend/dist",
		"../frontend/dist",
	}
	for _, candidate := range candidates {
		indexPath := filepath.Join(candidate, "index.html")
		if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "./frontend/dist"
}
