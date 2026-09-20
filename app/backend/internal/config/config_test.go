package config_test

import (
	"krss/backend/internal/config"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoad(t *testing.T) {
	// Set env vars
	os.Setenv("KRSS_ADDR", ":9999")
	os.Setenv("KRSS_DATA_DIR", "/tmp/krss")
	os.Setenv("KRSS_LOG_LEVEL", "debug")
	os.Setenv("KRSS_PPROF_ADDR", "127.0.0.1:6060")
	defer func() {
		os.Unsetenv("KRSS_ADDR")
		os.Unsetenv("KRSS_DATA_DIR")
		os.Unsetenv("KRSS_LOG_LEVEL")
		os.Unsetenv("KRSS_PPROF_ADDR")
	}()

	cfg := config.Load()
	require.Equal(t, ":9999", cfg.Addr)
	require.Equal(t, "/tmp/krss", cfg.DataDir)
	require.Contains(t, cfg.DBPath, "/tmp/krss/krss.db")
	require.Equal(t, "debug", cfg.LogLevel)
	require.Equal(t, "127.0.0.1:6060", cfg.PprofAddr)
}

func TestLoad_Defaults(t *testing.T) {
	// Clear env vars
	os.Unsetenv("KRSS_ADDR")
	os.Unsetenv("KRSS_DATA_DIR")
	os.Unsetenv("KRSS_DB_PATH")
	os.Unsetenv("KRSS_LOG_LEVEL")
	os.Unsetenv("KRSS_PPROF_ADDR")
	os.Unsetenv("KRSS_ENABLE_PPROF")

	cfg := config.Load()
	require.Equal(t, ":8080", cfg.Addr)
	require.Equal(t, "data", cfg.DataDir)
	require.Contains(t, cfg.DBPath, "krss.db")
	require.Equal(t, "info", cfg.LogLevel)
	require.Empty(t, cfg.PprofAddr)
}
