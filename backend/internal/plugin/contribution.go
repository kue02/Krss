package plugin

import (
	"context"

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

type InvokeResult struct {
	Message string   `json:"message,omitempty"`
	Level   string   `json:"level,omitempty"`
	Refresh []string `json:"refresh,omitempty"`
}
