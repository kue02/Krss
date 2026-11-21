package service_test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
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
		"plugin.json":   `{"id":"evil","name":"evil","version":"0.1.0","transport":"http","entrypoint":"./evil"}`,
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
		"plugin.json": `{"id":"builtin-x","name":"冒名","version":"0.1.0","transport":"http","entrypoint":"./x"}`,
		"x":           "#!/bin/sh\n",
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "x.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageExists)

	require.NoError(t, os.MkdirAll(filepath.Join(pluginsDir, "dup"), 0o755))
	payload = buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"dup","name":"重复","version":"0.1.0","transport":"http","entrypoint":"./dup"}`,
		"dup":         "#!/bin/sh\n",
	})
	_, err = svc.(packageInstaller).InstallPackage(context.Background(), "dup.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageExists)
}

func TestInstallPackage_RejectsMissingEntrypoint(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"noexe","name":"缺入口","version":"0.1.0","transport":"http","entrypoint":"./missing"}`,
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "noexe.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}

func TestInstallPackage_RejectsUnsupportedTransport(t *testing.T) {
	pluginsDir := t.TempDir()
	svc, _ := newUploadTestService(t, pluginsDir)
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"grpc-pack","name":"rpc","version":"0.1.0","transport":"grpc","entrypoint":"./grpc-pack"}`,
		"grpc-pack":   "#!/bin/sh\n",
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "grpc-pack.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
	_, statErr := os.Stat(filepath.Join(pluginsDir, "grpc-pack"))
	require.True(t, os.IsNotExist(statErr), "校验失败的包不能落盘留下孤儿目录")
}

func TestInstallPackage_RejectsDirectoryEntrypoint(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	payload := buildPluginZip(t, map[string]string{
		"plugin.json": `{"id":"dir-entry","name":"目录入口","version":"0.1.0","transport":"http","entrypoint":"./bin"}`,
		"bin/x":       "x",
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "dir-entry.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}

func TestInstallPackage_SkipsFinderMetadataAndSetsExecutable(t *testing.T) {
	pluginsDir := t.TempDir()
	svc, _ := newUploadTestService(t, pluginsDir)
	payload := buildPluginZip(t, map[string]string{
		"pkg/plugin.json":        `{"id":"pkg","name":"包根目录","version":"0.1.0","transport":"http","entrypoint":"./pkg"}`,
		"pkg/pkg":                "#!/bin/sh\n",
		"__MACOSX/pkg/._pkg":     "junk",
		"__MACOSX/._plugin.json": "junk",
		".DS_Store":              "junk",
	})
	items, err := svc.(packageInstaller).InstallPackage(context.Background(), "pkg.zip", bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err, "Finder 元数据不应让唯一顶层目录判定失败")
	var found bool
	for _, it := range items {
		if it.ID == "pkg" {
			found = true
		}
	}
	require.True(t, found)
	info, err := os.Stat(filepath.Join(pluginsDir, "pkg", "pkg"))
	require.NoError(t, err)
	require.NotZero(t, info.Mode().Perm()&0o111, "上传的入口必须补上可执行位")
}

func TestInstallPackage_RejectsSymlinkAndAbsolutePaths(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	build := func(add func(*zip.Writer)) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		w, err := zw.Create("plugin.json")
		require.NoError(t, err)
		_, err = w.Write([]byte(`{"id":"unsafe","name":"unsafe","version":"0.1.0","transport":"http","entrypoint":"./unsafe"}`))
		require.NoError(t, err)
		w, err = zw.Create("unsafe")
		require.NoError(t, err)
		_, err = w.Write([]byte("#!/bin/sh\n"))
		require.NoError(t, err)
		add(zw)
		require.NoError(t, zw.Close())
		return buf.Bytes()
	}

	symlinkPayload := build(func(zw *zip.Writer) {
		h := &zip.FileHeader{Name: "link", Method: zip.Store}
		h.SetMode(os.ModeSymlink | 0o777)
		w, err := zw.CreateHeader(h)
		require.NoError(t, err)
		_, err = w.Write([]byte("/etc/passwd"))
		require.NoError(t, err)
	})
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "symlink.zip", bytes.NewReader(symlinkPayload), int64(len(symlinkPayload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)

	absPayload := build(func(zw *zip.Writer) {
		w, err := zw.Create("/absolute.txt")
		require.NoError(t, err)
		_, err = w.Write([]byte("x"))
		require.NoError(t, err)
	})
	_, err = svc.(packageInstaller).InstallPackage(context.Background(), "abs.zip", bytes.NewReader(absPayload), int64(len(absPayload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}

func TestInstallPackage_RejectsOversizedPackage(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "huge.zip", bytes.NewReader([]byte{0}), (64<<20)+1)
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}

func TestInstallPackage_RejectsTooManyFiles(t *testing.T) {
	svc, _ := newUploadTestService(t, t.TempDir())
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i < 2001; i++ {
		w, err := zw.Create(fmt.Sprintf("f/%04d.txt", i))
		require.NoError(t, err)
		_, err = w.Write([]byte("x"))
		require.NoError(t, err)
	}
	require.NoError(t, zw.Close())
	payload := buf.Bytes()
	_, err := svc.(packageInstaller).InstallPackage(context.Background(), "many.zip", bytes.NewReader(payload), int64(len(payload)))
	require.ErrorIs(t, err, service.ErrPluginPackageInvalid)
}
