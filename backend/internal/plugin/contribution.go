package plugin

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"krss/backend/internal/model"
)

// Surface 是宿主暴露的「可插入位置」。名单由 krss 单方面决定，插件只能用这些。
type Surface string

const (
	SurfaceEntryContextMenu   Surface = "entry.contextmenu"
	SurfaceEntryListToolbar   Surface = "entry.list.toolbar"
	SurfaceEntryReaderToolbar Surface = "entry.reader.toolbar"
	SurfaceEntryReaderBody    Surface = "entry.reader.body"
	SurfaceFeedContextMenu    Surface = "feed.contextmenu"
	SurfaceFilterEditorFooter Surface = "filter.editor.footer"
	SurfaceSettingsSection    Surface = "settings.section"
	SurfaceAppCommand         Surface = "app.command"
	SurfaceViewToolbar        Surface = "view.toolbar"
)

var Surfaces = []Surface{
	SurfaceEntryContextMenu,
	SurfaceEntryListToolbar,
	SurfaceEntryReaderToolbar,
	SurfaceEntryReaderBody,
	SurfaceFeedContextMenu,
	SurfaceFilterEditorFooter,
	SurfaceSettingsSection,
	SurfaceAppCommand,
	SurfaceViewToolbar,
}

func IsSupportedSurface(s Surface) bool {
	for _, item := range Surfaces {
		if item == s {
			return true
		}
	}
	return false
}

const (
	SelectionNone   = "none"
	SelectionSingle = "single"
	SelectionMulti  = "multi"
)

type TextRange struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

type Selection struct {
	EntryIDs  []int64    `json:"entryIds,omitempty"`
	FeedIDs   []int64    `json:"feedIds,omitempty"`
	FilterID  *int64     `json:"filterId,omitempty"`
	ViewID    *int64     `json:"viewId,omitempty"`
	TextRange *TextRange `json:"textRange,omitempty"`
}

func (s Selection) IsEmpty() bool {
	return len(s.EntryIDs) == 0 && len(s.FeedIDs) == 0 && s.FilterID == nil && s.ViewID == nil && s.TextRange == nil
}

// Contribution 是插件声明的一条界面贡献。
type Contribution struct {
	// Plugin 由宿主在聚合时注入（插件自己声明时不用填）：前端靠它知道该调哪个插件。
	Plugin    string   `json:"plugin,omitempty"`
	ID        string   `json:"id"`
	Surface   Surface  `json:"surface"`
	Op        string   `json:"op,omitempty"`
	Target    string   `json:"target,omitempty"`
	Action    string   `json:"action"`
	Label     string   `json:"label"`
	Icon      string   `json:"icon,omitempty"`
	Group     string   `json:"group,omitempty"`
	Confirm   string   `json:"confirm,omitempty"`
	Fields    []Field  `json:"fields,omitempty"`
	Selection string   `json:"selection"`
	Refresh   []string `json:"refresh,omitempty"`
}

type ContributionsProvider interface {
	Contributions() []Contribution
}

type Invoker interface {
	Invoke(ctx context.Context, req InvokeRequest) (InvokeResult, error)
}

type InvokeRequest struct {
	Plugin    string            `json:"-"`
	Action    string            `json:"-"`
	Surface   Surface           `json:"surface"`
	Selection Selection         `json:"selection"`
	Config    map[string]string `json:"config,omitempty"`
	Entries   []model.Entry     `json:"entries,omitempty"`
	Feeds     []model.Feed      `json:"feeds,omitempty"`
	Filter    *model.Filter     `json:"filter,omitempty"`
}

// InvokeResult 界面直调的结果。Message/Level 给提示条，Refresh 让前端失效哪几块缓存，
// Files 是「插件产出了一个文件」（导出场景；56-30 的 Obsidian 导出是第一个用户）。
type InvokeResult struct {
	Message string       `json:"message,omitempty"`
	Level   string       `json:"level,omitempty"`
	Refresh []string     `json:"refresh,omitempty"`
	Files   []ExportFile `json:"files,omitempty"`
}

// ExportFile 插件导出的一份文件。内容由插件生成，宿主只负责命名与落盘/下载；
// Filename 允许带子目录（如 "krss/2026-10-27 一只猫.md"），宿主按目录建。
type ExportFile struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
	MIME     string `json:"mime,omitempty"`
}

// UnmarshalJSON 让 selection 里的 id 同时接受 JSON 字符串与数字。
// 前端 id 是 int64 的字符串形式（19 位）——走 number 会丢精度
// （实测 2114685590489272320 变成 ...300，插件就会去操作错条目），
// 所以宿主一律发字符串；手写 curl / 第三方插件发数字也认。
func (s *Selection) UnmarshalJSON(data []byte) error {
	var raw struct {
		EntryIDs  []json.RawMessage `json:"entryIds"`
		FeedIDs   []json.RawMessage `json:"feedIds"`
		FilterID  json.RawMessage   `json:"filterId"`
		ViewID    json.RawMessage   `json:"viewId"`
		TextRange *TextRange        `json:"textRange"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	entryIDs, err := parseIDList(raw.EntryIDs)
	if err != nil {
		return err
	}
	feedIDs, err := parseIDList(raw.FeedIDs)
	if err != nil {
		return err
	}
	filterID, err := parseIDPtr(raw.FilterID)
	if err != nil {
		return err
	}
	viewID, err := parseIDPtr(raw.ViewID)
	if err != nil {
		return err
	}
	*s = Selection{
		EntryIDs:  entryIDs,
		FeedIDs:   feedIDs,
		FilterID:  filterID,
		ViewID:    viewID,
		TextRange: raw.TextRange,
	}
	return nil
}

func parseIDList(items []json.RawMessage) ([]int64, error) {
	if len(items) == 0 {
		return nil, nil
	}
	out := make([]int64, 0, len(items))
	for _, item := range items {
		id, err := parseID(item)
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

func parseIDPtr(item json.RawMessage) (*int64, error) {
	text := strings.TrimSpace(string(item))
	if text == "" || text == "null" {
		return nil, nil
	}
	id, err := parseID(item)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func parseID(item json.RawMessage) (int64, error) {
	text := strings.Trim(strings.TrimSpace(string(item)), `"`)
	if text == "" {
		return 0, nil
	}
	return strconv.ParseInt(text, 10, 64)
}
