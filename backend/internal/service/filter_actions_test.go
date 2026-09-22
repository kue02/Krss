package service_test

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

// —— 假依赖：AI 与 webhook 都是「外部世界」，测试里一律用替身，绝不真出网/真花钱 ——

type fakeAI struct {
	replies []string
	err     error
	calls   int
	model   string
}

func (f *fakeAI) Complete(_ context.Context, _ string, _ string) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	if len(f.replies) == 0 {
		return "", errors.New("fake ai: no reply queued")
	}
	reply := f.replies[0]
	f.replies = f.replies[1:]
	return reply, nil
}

func (f *fakeAI) ModelName(context.Context) string { return f.model }

type fakeWebhook struct {
	mu      sync.Mutex
	status  int
	err     error
	calls   int
	payload string
	target  string
}

func (w *fakeWebhook) Send(_ context.Context, url string, payload []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.calls++
	w.target = url
	w.payload = string(payload)
	if w.err != nil {
		return w.status, w.err
	}
	return w.status, nil
}

func (w *fakeWebhook) snapshot() (int, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.calls, w.payload
}

type actionFixture struct {
	db      *sql.DB
	service service.FilterService
	entries repository.EntryRepository
	feeds   repository.FeedRepository
	filters repository.FilterRepository
	ai      *fakeAI
	webhook *fakeWebhook
}

func newActionFixture(t *testing.T, ai *fakeAI, webhook *fakeWebhook) *actionFixture {
	t.Helper()
	db := testutil.NewTestDB(t)
	entryRepo := repository.NewEntryRepository(db)
	feedRepo := repository.NewFeedRepository(db)
	folderRepo := repository.NewFolderRepository(db)
	filterRepo := repository.NewFilterRepository(db)

	deps := service.FilterServiceDeps{
		Filters: filterRepo,
		Entries: entryRepo,
		Feeds:   feedRepo,
		Folders: folderRepo,
	}
	if ai != nil {
		deps.AI = ai
	}
	if webhook != nil {
		deps.Webhook = webhook
	}

	return &actionFixture{
		db:      db,
		service: service.NewFilterService(deps),
		entries: entryRepo,
		feeds:   feedRepo,
		filters: filterRepo,
		ai:      ai,
		webhook: webhook,
	}
}

func (f *actionFixture) seedFeed(t *testing.T, title string) model.Feed {
	t.Helper()
	feed := model.Feed{Title: title, URL: "https://example.com/" + title + ".xml", Type: "article"}
	feed.ID = testutil.SeedFeed(t, f.db, feed)
	return feed
}

func (f *actionFixture) seedEntry(t *testing.T, feedID int64, hash, title, content string) model.Entry {
	t.Helper()
	entry := model.Entry{
		FeedID:  feedID,
		Hash:    hash,
		Title:   &title,
		URL:     strPtr("https://example.com/" + hash),
		Content: &content,
	}
	entry.ID = testutil.SeedEntry(t, f.db, entry)
	return entry
}

func (f *actionFixture) reload(t *testing.T, id int64) model.Entry {
	t.Helper()
	entry, err := f.entries.GetByID(context.Background(), id)
	require.NoError(t, err)
	return entry
}

func (f *actionFixture) reloadFilter(t *testing.T, id int64) model.Filter {
	t.Helper()
	filter, err := f.filters.GetByID(context.Background(), id)
	require.NoError(t, err)
	return filter
}

func (f *actionFixture) create(t *testing.T, params service.FilterWriteParams) model.Filter {
	t.Helper()
	created, err := f.service.Create(context.Background(), params)
	require.NoError(t, err)
	return created
}

// waitFor 轮询一个条件（webhook 是异步投递，结果要等一小会儿才落库）。
func waitFor(t *testing.T, timeout time.Duration, check func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func longText(minRunes int) string {
	var builder strings.Builder
	for builder.Len() < minRunes*3 {
		builder.WriteString("这是一段足够长的正文内容，用来让 AI 条件愿意去问模型。")
	}
	return builder.String()
}

// translate / summarize 动作只给条目打「打开时自动翻译 / 自动摘要」的标记，不在入库时花 AI token。
func TestFilterService_TranslateAndSummarizeMarkEntries(t *testing.T) {
	fixture := newActionFixture(t, nil, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "云厂商博客")
	entry := fixture.seedEntry(t, feed.ID, "hash-ai-marks", "Workers 更新", "正文")

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "命中就备好翻译与摘要",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
		Actions:    model.FilterActions{Translate: true, Summarize: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 1, applied)

	marked := fixture.reload(t, entry.ID)
	require.True(t, marked.AutoTranslate, "translate 动作应写条目级标记")
	require.True(t, marked.AutoSummary, "summarize 动作应写条目级标记")
	require.False(t, marked.Muted, "翻译/摘要不是静音")
	require.False(t, marked.Read, "翻译/摘要不该顺手改已读")
	require.NotNil(t, marked.FilterID)
	require.Equal(t, rule.ID, *marked.FilterID)

	// 撤销规则时把这两个标记也清掉（否则规则删了，条目还一直自动翻译）
	reverted, err := fixture.service.Revert(ctx, rule.ID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, reverted, int64(1))

	cleared := fixture.reload(t, entry.ID)
	require.False(t, cleared.AutoTranslate)
	require.False(t, cleared.AutoSummary)
}

// AI 条件：判定结果按 (条目, 主题) 缓存，命中一次之后不再重复问模型。
func TestFilterService_AIRelevanceConditionCachesVerdict(t *testing.T) {
	ai := &fakeAI{replies: []string{"YES"}, model: "fake-model"}
	fixture := newActionFixture(t, ai, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	entry := fixture.seedEntry(t, feed.ID, "hash-ai-yes", "一篇很长的技术文", longText(400))

	fixture.create(t, service.FilterWriteParams{
		Name:      "与我相关就加星",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field:    model.FilterFieldAIRelevance,
			Operator: model.FilterOpIsRelevant,
			Value:    "AI 编程工具",
		}},
		Actions: model.FilterActions{Star: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 1, applied)
	require.Equal(t, 1, ai.calls, "第一次要真的问一次模型")
	require.True(t, fixture.reload(t, entry.ID).Starred)

	// 再跑一次：判定已在缓存里，模型调用次数不该增加
	_, err = fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 1, ai.calls, "同一条目同一主题只问一次模型")
}

// AI 条件判成「不相关」时规则不生效。
func TestFilterService_AIRelevanceConditionCanReject(t *testing.T) {
	ai := &fakeAI{replies: []string{"NO"}, model: "fake-model"}
	fixture := newActionFixture(t, ai, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	entry := fixture.seedEntry(t, feed.ID, "hash-ai-no", "一篇很长的技术文", longText(400))

	fixture.create(t, service.FilterWriteParams{
		Name:      "与我相关就加星",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field:    model.FilterFieldAIRelevance,
			Operator: model.FilterOpIsRelevant,
			Value:    "AI 编程工具",
		}},
		Actions: model.FilterActions{Star: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 0, applied)
	require.False(t, fixture.reload(t, entry.ID).Starred)
}

// 正文太短不问模型，但必须把「为什么没判」写到规则上（失败要看得见）。
func TestFilterService_AIRelevanceSkipsShortContentWithVisibleReason(t *testing.T) {
	ai := &fakeAI{replies: []string{"YES"}, model: "fake-model"}
	fixture := newActionFixture(t, ai, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "短内容源")
	entry := fixture.seedEntry(t, feed.ID, "hash-ai-short", "短讯", "太短了")

	rule := fixture.create(t, service.FilterWriteParams{
		Name:      "与我相关就加星",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field:    model.FilterFieldAIRelevance,
			Operator: model.FilterOpIsRelevant,
			Value:    "AI 编程工具",
		}},
		Actions: model.FilterActions{Star: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 0, applied)
	require.Equal(t, 0, ai.calls, "正文过短不该花 token")

	stored := fixture.reloadFilter(t, rule.ID)
	require.NotNil(t, stored.LastError, "没判成必须在规则上留下原因")
	require.Contains(t, *stored.LastError, "正文短于")
}

// AI 没配置：AI 条件不命中，并且规则上写明原因（绝不静默）。
func TestFilterService_AIRelevanceWithoutProviderRecordsReason(t *testing.T) {
	fixture := newActionFixture(t, nil, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	entry := fixture.seedEntry(t, feed.ID, "hash-ai-none", "一篇很长的技术文", longText(400))

	rule := fixture.create(t, service.FilterWriteParams{
		Name:      "与我相关就加星",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field:    model.FilterFieldAIRelevance,
			Operator: model.FilterOpIsRelevant,
			Value:    "AI 编程工具",
		}},
		Actions: model.FilterActions{Star: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 0, applied)

	stored := fixture.reloadFilter(t, rule.ID)
	require.NotNil(t, stored.LastError)
	require.Contains(t, *stored.LastError, "AI 未配置")
}

// webhook 动作：命中异步投递；失败写在规则上，下一次成功自动清掉。
func TestFilterService_WebhookFailureAndRecovery(t *testing.T) {
	webhook := &fakeWebhook{status: 500, err: errors.New("HTTP 500")}
	fixture := newActionFixture(t, nil, webhook)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "通知源")
	entry := fixture.seedEntry(t, feed.ID, "hash-hook", "值得推一条", "正文")

	rule := fixture.create(t, service.FilterWriteParams{
		Name:      "命中就打到钩子",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "推一条",
		}},
		Actions: model.FilterActions{Webhook: true, WebhookURL: "https://example.com/hook"},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	require.True(t, waitFor(t, 2*time.Second, func() bool {
		return fixture.reloadFilter(t, rule.ID).LastError != nil
	}), "投递失败应写回规则的 last_error")

	stored := fixture.reloadFilter(t, rule.ID)
	require.Contains(t, *stored.LastError, "webhook 投递失败")
	require.Contains(t, *stored.LastError, "HTTP 500")

	calls, payload := webhook.snapshot()
	require.Equal(t, 1, calls)
	require.Contains(t, payload, "值得推一条", "报文里要带上命中的条目")
	require.Contains(t, payload, "filter.matched")

	// 下游修好了：再命中一次，错误要被清掉
	webhook.mu.Lock()
	webhook.err = nil
	webhook.status = 200
	webhook.mu.Unlock()

	_, err = fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.True(t, waitFor(t, 2*time.Second, func() bool {
		return fixture.reloadFilter(t, rule.ID).LastError == nil
	}), "投递成功应清掉上一次的错误")
}

// 视图（kind=view）只筛条目，引擎完全跳过它：不写任何标记、不计数。
func TestFilterService_ViewsAreSkippedByEngine(t *testing.T) {
	fixture := newActionFixture(t, nil, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	entry := fixture.seedEntry(t, feed.ID, "hash-view", "Workers 与 AI", "正文")

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "只看 Workers",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
	})
	require.Equal(t, model.FilterKindView, view.Kind)
	require.True(t, view.Actions.IsEmpty(), "视图不该带动作")

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.Equal(t, 0, applied, "视图不执行动作")

	stored := fixture.reload(t, entry.ID)
	require.False(t, stored.Muted)
	require.False(t, stored.Starred)
	require.Nil(t, stored.FilterID)
}

// 视图的参数校验：必须有条件、不能带动作。
func TestValidateFilterParams_ViewRules(t *testing.T) {
	conditions := []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}}

	require.NoError(t, service.ValidateFilterParams(service.FilterWriteParams{
		Name: "只看 Workers", Kind: model.FilterKindView, ScopeType: model.FilterScopeAll, Conditions: conditions,
	}))

	// 视图没有条件 = 「全部」，没有意义
	require.ErrorIs(t, service.ValidateFilterParams(service.FilterWriteParams{
		Name: "空视图", Kind: model.FilterKindView, ScopeType: model.FilterScopeAll,
	}), service.ErrInvalidFilter)

	// 视图不能带动作（它不写数据）
	require.ErrorIs(t, service.ValidateFilterParams(service.FilterWriteParams{
		Name: "带动作的视图", Kind: model.FilterKindView, ScopeType: model.FilterScopeAll,
		Conditions: conditions, Actions: model.FilterActions{Mute: true},
	}), service.ErrInvalidFilter)

	// 未知 kind
	require.ErrorIs(t, service.ValidateFilterParams(service.FilterWriteParams{
		Name: "怪种类", Kind: "pipeline", ScopeType: model.FilterScopeAll,
		Conditions: conditions, Actions: model.FilterActions{Mute: true},
	}), service.ErrInvalidFilter)
}

// webhook 动作必须带合法地址；AI 条件只配 is_relevant。
func TestValidateFilterParams_WebhookAndAIConditions(t *testing.T) {
	base := service.FilterWriteParams{
		Name:       "规则",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "x"}},
		Actions:    model.FilterActions{Webhook: true, WebhookURL: "https://example.com/hook"},
	}
	require.NoError(t, service.ValidateFilterParams(base))

	noURL := base
	noURL.Actions = model.FilterActions{Webhook: true}
	require.ErrorIs(t, service.ValidateFilterParams(noURL), service.ErrInvalidFilter)

	badScheme := base
	badScheme.Actions = model.FilterActions{Webhook: true, WebhookURL: "file:///etc/passwd"}
	require.ErrorIs(t, service.ValidateFilterParams(badScheme), service.ErrInvalidFilter)

	// AI 条件：字段与操作符必须配对
	wrongOperator := base
	wrongOperator.Conditions = []model.FilterCondition{{Field: model.FilterFieldAIRelevance, Operator: model.FilterOpContains, Value: "AI"}}
	require.ErrorIs(t, service.ValidateFilterParams(wrongOperator), service.ErrInvalidFilter)

	operatorOnText := base
	operatorOnText.Conditions = []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpIsRelevant, Value: "AI"}}
	require.ErrorIs(t, service.ValidateFilterParams(operatorOnText), service.ErrInvalidFilter)

	tooLongTopic := base
	tooLongTopic.Conditions = []model.FilterCondition{{
		Field: model.FilterFieldAIRelevance, Operator: model.FilterOpIsRelevant, Value: strings.Repeat("长", 201),
	}}
	require.ErrorIs(t, service.ValidateFilterParams(tooLongTopic), service.ErrInvalidFilter)
}

// 「豁免这类内容」：例外规则排在最前、只做反向动作，并立刻放行这一条。
func TestFilterService_CreateExceptionReleasesEntry(t *testing.T) {
	fixture := newActionFixture(t, nil, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	entry := fixture.seedEntry(t, feed.ID, "hash-exempt", "赞助：某云厂商推广", "正文")

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "屏蔽赞助",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助"}},
		Actions:    model.FilterActions{Mute: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	muted := fixture.reload(t, entry.ID)
	require.True(t, muted.Muted)
	require.True(t, muted.Read)

	exception, err := fixture.service.CreateException(ctx, entry.ID)
	require.NoError(t, err)
	require.Less(t, exception.Position, rule.Position, "例外规则必须排在所有规则之前（首个命中即停）")
	require.True(t, exception.Actions.Unmute)
	require.True(t, exception.Actions.MarkUnread)
	require.NotNil(t, exception.ScopeID)
	require.Equal(t, feed.ID, *exception.ScopeID)
	require.Len(t, exception.Conditions, 1)
	require.Equal(t, model.FilterFieldURL, exception.Conditions[0].Field)
	require.Equal(t, model.FilterOpExact, exception.Conditions[0].Operator)

	released := fixture.reload(t, entry.ID)
	require.False(t, released.Muted, "这一条要立刻放回未读流")
	require.False(t, released.Read)
	require.Nil(t, released.FilterID)

	// 例外规则也算它干过活：命中日志里有一条
	matches, err := fixture.service.ListMatches(ctx, exception.ID, 10)
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Equal(t, entry.ID, matches[0].EntryID)

	// 条目不存在 → 404 语义
	_, err = fixture.service.CreateException(ctx, 999999)
	require.ErrorIs(t, err, service.ErrEntryNotFound)
}

// 自然语言建规则：解析草稿、纠正模型编的 id、拒绝没法用的输出。
func TestFilterService_ParseNaturalLanguage(t *testing.T) {
	valid := "```json\n{\n  \"name\": \"屏蔽赞助\",\n  \"scopeType\": \"all\",\n  \"scopeId\": null,\n  \"conditions\": [{\"logic\": \"and\", \"field\": \"title\", \"operator\": \"contains\", \"value\": \"赞助\"}],\n  \"actions\": {\"mute\": true},\n  \"notes\": \"把标题里带赞助的都静音\"\n}\n```"

	t.Run("解析出可用草稿", func(t *testing.T) {
		ai := &fakeAI{replies: []string{valid}, model: "fake-model"}
		fixture := newActionFixture(t, ai, nil)

		draft, err := fixture.service.ParseNaturalLanguage(context.Background(), "把带赞助的都静音")
		require.NoError(t, err)
		require.Equal(t, "屏蔽赞助", draft.Name)
		require.Equal(t, model.FilterScopeAll, draft.ScopeType)
		require.Len(t, draft.Conditions, 1)
		require.True(t, draft.Actions.Mute)
		require.Contains(t, draft.Notes, "静音")
		require.Equal(t, 1, ai.calls)
	})

	t.Run("模型编的 scopeId 被纠正并留 warning", func(t *testing.T) {
		bogus := `{"name":"只看某个不存在的源","scopeType":"feed","scopeId":"123456789","conditions":[{"field":"title","operator":"contains","value":"x"}],"actions":{"star":true}}`
		ai := &fakeAI{replies: []string{bogus}, model: "fake-model"}
		fixture := newActionFixture(t, ai, nil)

		draft, err := fixture.service.ParseNaturalLanguage(context.Background(), "只看某个源")
		require.NoError(t, err)
		require.Equal(t, model.FilterScopeAll, draft.ScopeType)
		require.Nil(t, draft.ScopeID)
		require.NotEmpty(t, draft.Warnings, "纠正了什么必须说出来")
	})

	t.Run("输出没法用 → ErrAIDraftInvalid", func(t *testing.T) {
		ai := &fakeAI{replies: []string{"我觉得你想说的是把广告都屏蔽掉。"}, model: "fake-model"}
		fixture := newActionFixture(t, ai, nil)

		_, err := fixture.service.ParseNaturalLanguage(context.Background(), "屏蔽广告")
		require.ErrorIs(t, err, service.ErrAIDraftInvalid)
	})

	t.Run("AI 没配 → ErrAIUnavailable", func(t *testing.T) {
		fixture := newActionFixture(t, nil, nil)
		_, err := fixture.service.ParseNaturalLanguage(context.Background(), "屏蔽广告")
		require.ErrorIs(t, err, service.ErrAIUnavailable)
	})

	t.Run("空话不发给模型", func(t *testing.T) {
		ai := &fakeAI{replies: []string{valid}, model: "fake-model"}
		fixture := newActionFixture(t, ai, nil)

		_, err := fixture.service.ParseNaturalLanguage(context.Background(), "   ")
		require.ErrorIs(t, err, service.ErrInvalidFilter)
		require.Equal(t, 0, ai.calls)
	})
}

// 回归：回溯某条「没有 AI 条件」的规则时，别的规则的 AI 条件跳过的条目不该记到它头上。
// （e2e 实测抓到过：一次回溯把「AI 判定：13 条正文短于 400 字」写到了 webhook 规则上。）
func TestFilterService_ApplyToHistoryBlamingTheRightRule(t *testing.T) {
	ai := &fakeAI{replies: []string{"YES"}, model: "fake-model"}
	fixture := newActionFixture(t, ai, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	// 正文过短 → AI 条件会被跳过（不留缓存、也不问模型）
	short := fixture.seedEntry(t, feed.ID, "hash-short", "短文一条", "太短")

	aiRule := fixture.create(t, service.FilterWriteParams{
		Name:      "AI 条件规则",
		ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{{
			Field:    model.FilterFieldAIRelevance,
			Operator: model.FilterOpIsRelevant,
			Value:    "AI 编程工具",
		}},
		Actions: model.FilterActions{Star: true},
	})
	plainRule := fixture.create(t, service.FilterWriteParams{
		Name:       "普通规则",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "短文"}},
		Actions:    model.FilterActions{MarkRead: true},
	})
	require.Equal(t, 0, aiRule.Position)
	require.Equal(t, 1, plainRule.Position)

	// 回溯那条普通规则：它自己没有任何 AI 条件
	_, applied, err := fixture.service.ApplyToHistory(ctx, plainRule.ID, 50)
	require.NoError(t, err)
	require.Equal(t, 1, applied)
	require.True(t, fixture.reload(t, short.ID).Read)

	require.Nil(t, fixture.reloadFilter(t, plainRule.ID).LastError,
		"没有 AI 条件的规则不该背 AI 的提示")
	aiStored := fixture.reloadFilter(t, aiRule.ID)
	require.NotNil(t, aiStored.LastError, "原因要落在真正带 AI 条件的那条规则上")
	require.Contains(t, *aiStored.LastError, "正文短于")
}

// 保存筛选视图：列表按视图的作用域 + 条件取数，规则 id 不认。
func TestEntryService_ListByView(t *testing.T) {
	fixture := newActionFixture(t, nil, nil)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "技术源")
	otherFeed := fixture.seedFeed(t, "生活源")

	work := fixture.seedEntry(t, feed.ID, "hash-view-work", "Workers 新特性", "正文")
	fixture.seedEntry(t, otherFeed.ID, "hash-view-other", "Workers 在家做饭", "正文")
	fixture.seedEntry(t, feed.ID, "hash-view-noise", "周末去哪儿玩", "正文")

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "只看这个源的 Workers",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
	})

	entryService := service.NewEntryService(fixture.entries, fixture.feeds, repository.NewFolderRepository(fixture.db), fixture.filters)

	entries, err := entryService.List(ctx, service.EntryListParams{ViewID: &view.ID, Limit: 10})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, work.ID, entries[0].ID)

	// 分页口径：offset 落在「筛选后」的位置上
	empty, err := entryService.List(ctx, service.EntryListParams{ViewID: &view.ID, Limit: 10, Offset: 1})
	require.NoError(t, err)
	require.Empty(t, empty)

	// 拿规则 id 当 viewId 用 → 当作找不到（规则不是视图）
	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "规则",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
		Actions:    model.FilterActions{Mute: true},
	})
	_, err = entryService.List(ctx, service.EntryListParams{ViewID: &rule.ID, Limit: 10})
	require.ErrorIs(t, err, service.ErrNotFound)
}
