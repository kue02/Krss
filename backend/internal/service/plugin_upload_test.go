package service_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

type packageInstaller interface {
	InstallPackage(ctx context.Context, filename string, r io.ReaderAt, size int64) ([]plugin.CatalogItem, error)
}

type builtinStub struct{ meta plugin.Meta }

func (b builtinStub) Meta() plugin.Meta                          { return b.meta }
func (b builtinStub) Actions() []plugin.Action                   { return nil }
func (b builtinStub) SettingsSections() []plugin.SettingsSection { return nil }
func (b builtinStub) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (b builtinStub) FetchClassifiers() []plugin.FetchClassifier { return nil }

// buildPluginZip 造一个最小可安装插件包；files 的键是 zip 内路径。
func buildPluginZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		require.NoError(t, err)
		_, err = w.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, zw.Close())
	return buf.Bytes()
}

func newUploadTestService(t *testing.T, pluginsDir string) (service.PluginService, *plugin.Registry) {
	t.Helper()
	db := testutil.NewTestDB(t)
	pluginRepo := repository.NewPluginRepository(db)
	settingsRepo := repository.NewSettingsRepository(db)
	reg := plugin.NewRegistry()
	host := service.NewPluginHost(reg, pluginRepo, pluginsDir,
		service.WithPluginReadyTimeout(50*time.Millisecond),
		service.WithPluginBackoff(10*time.Millisecond, 50*time.Millisecond),
		service.WithPluginStopGrace(50*time.Millisecond),
	)
	t.Cleanup(host.Stop)
	return service.NewPluginService(reg, pluginRepo, settingsRepo, service.WithPluginHost(host)), reg
}

func TestInstallPackage_InstallsZipAndStaysDisabled(t *testing.T) {
	pluginsDir := t.TempDir()
	svc, _ := newUploadTestService(t, pluginsDir)
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"hello-pack","name":"包里来的","version":"0.1.0","transport":"http","entrypoint":"./hello-pack","autostart":true}`,
		"hello-pack":  "#!/bin/sh\n",
	})
	items, err := svc.(packageInstaller).InstallPackage(context.Background(), "hello-pack.zip", bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)
	var found *plugin.CatalogItem
	for i := range items {
		if items[i].ID == "hello-pack" {
			found = &items[i]
		}
	}
	require.NotNil(t, found, "清单里应出现刚装的插件")
	require.False(t, found.Enabled, "新装插件必须默认停用")
	require.True(t, found.Transport == plugin.TransportHTTP)

	manifest, err := os.ReadFile(filepath.Join(pluginsDir, "hello-pack", "plugin.json"))
	require.NoError(t, err)
	require.Contains(t, string(manifest), `"hello-pack"`)
}

func TestInstallPackage_RejectsPathTraversal(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	payload := buildPluginZip(t, map[string]string{
		"plugin.json":   `{"id":"evil","name":"evil","transport":"http","entrypoint":"./evil"}`,
		"../escape.txt": "x",
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "evil.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}

func TestInstallPackage_RejectsDuplicateAndBuiltinID(t *testing.T) {
	pluginsDir := t.TempDir()
	svc, reg := newUploadTestService(t, pluginsDir)
	require.NoError(t, reg.Register(builtinStub{meta: plugin.Meta{ID: "builtin-x", Name: "内置", Builtin: true}}))
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"builtin-x","name":"冒名","transport":"http","entrypoint":"./x"}`,
		"x":           "#!/bin/sh\n",
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "x.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageExists)

	require.NoError(t, os.MkdirAll(filepath.Join(pluginsDir, "dup"), 0o755))
	payload = buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"dup","name":"重复","transport":"http","entrypoint":"./dup"}`,
		"dup":         "#!/bin/sh\n",
	})
	_, err = svc.(packageInstaller).InstallPackage(context.Background(), "dup.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageExists)
}

func TestInstallPackage_RejectsMissingEntrypoint(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"noexe","name":"缺入口","transport":"http","entrypoint":"./missing"}`,
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "noexe.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}
