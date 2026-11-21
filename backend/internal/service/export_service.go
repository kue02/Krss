package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrExportDirNotSet 没配导出目录 —— 调用方（前端）据此回落到浏览器下载。
var ErrExportDirNotSet = errors.New("未设置导出目录")

// 单个导出文件的上限：插件返回的是文本（md/json），8MB 足够，也挡住误传大文件把盘写满。
const maxExportFileBytes = 8 << 20

// ExportFile 插件导出的一批文件。Name 只取文件名（带路径一律截成 basename），
// Content 原样写盘 —— 宿主不改插件产出的一个字节。
type ExportFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// ExportService 把插件导出的文件写到「设置 → 通用 → 导出目录」。
//
// 为什么是宿主能力而不是插件能力：任何插件都可能导出（标注、笔记、备份……），
// 落盘位置是用户的环境决定，不该每个插件各自实现一遍、各自要一次路径。
type ExportService interface {
	// WriteFiles 写盘并返回绝对路径；目录没配回 ErrExportDirNotSet。
	WriteFiles(ctx context.Context, files []ExportFile) ([]string, error)
}

type exportService struct {
	settings SettingsService
}

// NewExportService 构造导出服务（目录读自通用设置）。
func NewExportService(settings SettingsService) ExportService {
	return &exportService{settings: settings}
}

func (s *exportService) WriteFiles(ctx context.Context, files []ExportFile) ([]string, error) {
	if len(files) == 0 {
		return nil, fmt.Errorf("没有要导出的文件")
	}
	general, err := s.settings.GetGeneralSettings(ctx)
	if err != nil {
		return nil, fmt.Errorf("读导出目录: %w", err)
	}
	dir := strings.TrimSpace(general.ExportDir)
	if dir == "" {
		return nil, ErrExportDirNotSet
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("导出目录不存在或不是文件夹：%s", dir)
	}

	paths := make([]string, 0, len(files))
	for _, file := range files {
		name := filepath.Base(strings.TrimSpace(file.Name))
		if name == "" || name == "." || name == ".." || strings.HasPrefix(name, ".") {
			return nil, fmt.Errorf("非法文件名：%q", file.Name)
		}
		if len(file.Content) > maxExportFileBytes {
			return nil, fmt.Errorf("%s 太大（超过 %d MB）", name, maxExportFileBytes>>20)
		}
		target := filepath.Join(dir, name)
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return nil, fmt.Errorf("写 %s: %w", name, err)
		}
		paths = append(paths, target)
	}
	return paths, nil
}
