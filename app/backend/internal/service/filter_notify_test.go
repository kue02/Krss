package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

// fakeNotifier 记下「谁被推到了哪个地址、推了什么」，并可按需返回失败。
// 用互斥锁是因为真实发送走的是后台 goroutine。
type fakeNotifier struct {
	mu     sync.Mutex
	global string
	status int
	err    error
	sent   []notifyCall
}

type notifyCall struct {
	target  string
	payload []byte
}

func (f *fakeNotifier) GlobalURL(context.Context) string { return f.global }

func (f *fakeNotifier) Send(_ context.Context, target string, payload []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, notifyCall{target: target, payload: payload})
	return f.status, f.err
}

func (f *fakeNotifier) calls() []notifyCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]notifyCall, len(f.sent))
	copy(out, f.sent)
	return out
}

type notifyFixture struct {
	*filterFixture
	notifier *fakeNotifier
}

// newNotifyFixture 与 filterFixture 同一套真库，只是把推送通道换成假的（不真出网）。
func newNotifyFixture(t *testing.T, globalURL string) *notifyFixture {
	t.Helper()
	dbConn := testutil.NewTestDB(t)
	entryRepo := repository.NewEntryRepository(dbConn)
	feedRepo := repository.NewFeedRepository(dbConn)
	folderRepo := repository.NewFolderRepository(dbConn)
	filterRepo := repository.NewFilterRepository(dbConn)
	notifier := &fakeNotifier{global: globalURL, status: 200}

	svc := service.NewFilterService(service.FilterServiceDeps{
		Filters: filterRepo,
		Entries: entryRepo,
		Feeds:   feedRepo,
		Folders: folderRepo,
		Notify:  notifier,
	})

	return &notifyFixture{
		filterFixture: &filterFixture{
			db:      dbConn,
			service: svc,
			entries: entryRepo,
			feeds:   feedRepo,
			filters: filterRepo,
		},
		notifier: notifier,
	}
}

// 推送是异步的：等它真的发出去再断言
func (f *notifyFixture) waitForSend(t *testing.T, want int) []notifyCall {
	t.Helper()
	require.Eventually(t, func() bool { return len(f.notifier.calls()) >= want },
		3*time.Second, 20*time.Millisecond, "推送没有发出去")
	return f.notifier.calls()
}

// 规则里填了地址 → 推到规则地址（而不是全局地址），内容带上标题/来源/链接/分组
func TestFilterService_Notify_UsesRuleURL(t *testing.T) {
	fixture := newNotifyFixture(t, "https://api.day.app/GLOBAL")
	ctx := context.Background()

	feed := fixture.seedFeed(t, "小众软件", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-notify-1", "Windows 上的新玩具", timePtr(time.Now()))

	fixture.create(t, service.FilterWriteParams{
		Name:       "重要更新提醒",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Windows"}},
		Actions:    model.FilterActions{Notify: true, NotifyURL: "https://api.day.app/RULE_KEY"},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	sent := fixture.waitForSend(t, 1)
	require.Equal(t, "https://api.day.app/RULE_KEY", sent[0].target, "规则里填的地址优先于全局地址")

	var payload service.FilterNotifyPayload
	require.NoError(t, json.Unmarshal(sent[0].payload, &payload))
	require.Equal(t, "Windows 上的新玩具", payload.Title)
	require.Contains(t, payload.Body, "小众软件")
	require.Contains(t, payload.Body, "重要更新提醒")
	require.Equal(t, *entry.URL, payload.URL, "点开推送要能直达条目")
	require.Equal(t, "Krss 自动化", payload.Group)
}

// 规则没填地址 → 跟随设置里的全局推送地址（这是与 webhook 不同的地方：空地址是合法的）
func TestFilterService_Notify_FallsBackToGlobalURL(t *testing.T) {
	fixture := newNotifyFixture(t, "https://api.day.app/GLOBAL_KEY")
	ctx := context.Background()

	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-notify-2", "标题里有 Workers", timePtr(time.Now()))

	fixture.create(t, service.FilterWriteParams{
		Name:       "跟随全局",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
		Actions:    model.FilterActions{Notify: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	sent := fixture.waitForSend(t, 1)
	require.Equal(t, "https://api.day.app/GLOBAL_KEY", sent[0].target)
}

// 两边都没地址 → 不发，且规则的 last_error 上写明原因（要出网的动作不能静默失败）
func TestFilterService_Notify_NoAddressMarksLastError(t *testing.T) {
	fixture := newNotifyFixture(t, "")
	ctx := context.Background()

	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-notify-3", "随便一个标题", timePtr(time.Now()))

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "没配地址的推送",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "随便"}},
		Actions:    model.FilterActions{Notify: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	require.Empty(t, fixture.notifier.calls(), "没地址就不该发")
	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError != nil
	}, 3*time.Second, 20*time.Millisecond)

	got, err := fixture.filters.GetByID(ctx, rule.ID)
	require.NoError(t, err)
	require.NotNil(t, got.LastError)
	require.Contains(t, *got.LastError, "推送失败：")
	require.Contains(t, *got.LastError, "全局推送地址")
}

// 投递失败：原因写进 last_error，且**不把带 key 的地址写出去**（推送地址是凭证）
func TestFilterService_Notify_FailureRedactsKeyInLastError(t *testing.T) {
	fixture := newNotifyFixture(t, "")
	ctx := context.Background()

	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-notify-4", "含 Secret 的标题", timePtr(time.Now()))

	keyedURL := "https://api.day.app/SECRET_DEVICE_KEY"
	fixture.notifier.err = errors.New(`Post "` + keyedURL + `": dial tcp: connect: connection refused`)

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "会失败的推送",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Secret"}},
		Actions:    model.FilterActions{Notify: true, NotifyURL: keyedURL},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	fixture.waitForSend(t, 1)

	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError != nil
	}, 3*time.Second, 20*time.Millisecond)

	got, err := fixture.filters.GetByID(ctx, rule.ID)
	require.NoError(t, err)
	require.NotNil(t, got.LastError)
	require.Contains(t, *got.LastError, "推送失败：")
	require.Contains(t, *got.LastError, "connection refused", "下游的原因要带回来")
	require.NotContains(t, *got.LastError, "SECRET_DEVICE_KEY", "地址里的设备 key 不能写进 last_error")
	require.Contains(t, *got.LastError, "api.day.app", "但主机名要知道，便于排查")
}

// 发成功要把「上一次是推送报的错」清掉（不碰 AI / webhook 留下的话）
func TestFilterService_Notify_SuccessClearsPreviousNotifyError(t *testing.T) {
	fixture := newNotifyFixture(t, "https://api.day.app/GLOBAL")
	ctx := context.Background()

	feed := fixture.seedFeed(t, "来源", "article")
	entry := fixture.seedEntry(t, feed.ID, "h-notify-5", "标题带 Magic", timePtr(time.Now()))

	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "先失败后成功",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Magic"}},
		Actions:    model.FilterActions{Notify: true},
	})

	// 先留下上一次的推送报错
	stale := "推送失败：上一次地址填错了"
	require.NoError(t, fixture.filters.SetLastError(ctx, rule.ID, stale, time.Now()))

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	fixture.waitForSend(t, 1)

	require.Eventually(t, func() bool {
		got, getErr := fixture.filters.GetByID(ctx, rule.ID)
		return getErr == nil && got.LastError == nil
	}, 3*time.Second, 20*time.Millisecond)
}

// 设置页的「发送测试推送」：没配地址要明确失败，配上就真发一条
func TestFilterService_TestNotify(t *testing.T) {
	t.Run("没配地址 → ErrInvalid", func(t *testing.T) {
		fixture := newNotifyFixture(t, "")
		_, err := fixture.service.TestNotify(context.Background())
		require.ErrorIs(t, err, service.ErrInvalid)
		require.Empty(t, fixture.notifier.calls())
	})

	t.Run("配了地址 → 真发一条", func(t *testing.T) {
		fixture := newNotifyFixture(t, "https://api.day.app/GLOBAL_KEY")
		status, err := fixture.service.TestNotify(context.Background())
		require.NoError(t, err)
		require.Equal(t, 200, status)

		sent := fixture.notifier.calls()
		require.Len(t, sent, 1)
		require.Equal(t, "https://api.day.app/GLOBAL_KEY", sent[0].target)
		var payload service.FilterNotifyPayload
		require.NoError(t, json.Unmarshal(sent[0].payload, &payload))
		require.Contains(t, payload.Title, "测试推送")
	})

	t.Run("投递失败 → 把下游原因带回来且不含 key", func(t *testing.T) {
		fixture := newNotifyFixture(t, "https://api.day.app/SECRET_KEY")
		fixture.notifier.err = errors.New(`Post "https://api.day.app/SECRET_KEY": context deadline exceeded`)
		fixture.notifier.status = 0

		_, err := fixture.service.TestNotify(context.Background())
		require.Error(t, err)
		require.Contains(t, err.Error(), "context deadline exceeded")
		require.NotContains(t, err.Error(), "SECRET_KEY")
	})
}
