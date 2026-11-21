package service_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// TestExportService_WriteFiles 插件导出落到「设置 → 通用 → 导出目录」（56-33）。
func TestExportService_WriteFiles(t *testing.T) {
	dir := t.TempDir()
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetGeneralSettings(gomock.Any()).Return(&service.GeneralSettings{ExportDir: dir}, nil)

	svc := service.NewExportService(settings)
	paths, err := svc.WriteFiles(context.Background(), []service.ExportFile{
		{Name: "标注-某条目.md", Content: "# 标题\n\n正文"},
	})
	require.NoError(t, err)
	require.Len(t, paths, 1)

	written, err := os.ReadFile(filepath.Join(dir, "标注-某条目.md"))
	require.NoError(t, err)
	require.Equal(t, "# 标题\n\n正文", string(written), "内容一个字节都不许改")
}

// TestExportService_NoDir 没配目录 → ErrExportDirNotSet（前端据此回落浏览器下载）。
func TestExportService_NoDir(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetGeneralSettings(gomock.Any()).Return(&service.GeneralSettings{}, nil)

	_, err := service.NewExportService(settings).WriteFiles(context.Background(), []service.ExportFile{{Name: "a.md", Content: "x"}})
	require.ErrorIs(t, err, service.ErrExportDirNotSet)
}

// TestExportService_RejectsPathTraversal 文件名带路径只取 basename；点开头的一律拒。
//
// 这是唯一能让插件写到导出目录之外的口子（插件返回的 name 是它自己写的）。
func TestExportService_RejectsPathTraversal(t *testing.T) {
	dir := t.TempDir()
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetGeneralSettings(gomock.Any()).Return(&service.GeneralSettings{ExportDir: dir}, nil).AnyTimes()

	svc := service.NewExportService(settings)

	paths, err := svc.WriteFiles(context.Background(), []service.ExportFile{
		{Name: "../../evil.md", Content: "x"},
	})
	require.NoError(t, err)
	require.Equal(t, filepath.Join(dir, "evil.md"), paths[0], "必须落在导出目录里")

	_, err = svc.WriteFiles(context.Background(), []service.ExportFile{{Name: ".hidden", Content: "x"}})
	require.Error(t, err, "点开头的文件（含 .、..）一律拒")

	_, err = svc.WriteFiles(context.Background(), []service.ExportFile{{Name: "..", Content: "x"}})
	require.Error(t, err)
}
