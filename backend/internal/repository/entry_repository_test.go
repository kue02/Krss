package repository_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

func TestEntryRepository_CreateAndGet(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Test Entry"
	url := "https://example.com/entry"
	entry := model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &url,
		Hash:   hashString(url),
	}

	err := repo.CreateOrUpdate(ctx, entry)
	require.NoError(t, err)

	// List to find the ID
	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	entryID := entries[0].ID

	fetched, err := repo.GetByID(ctx, entryID)
	require.NoError(t, err)
	require.Equal(t, entryID, fetched.ID)
	require.Equal(t, title, *fetched.Title)
	require.Equal(t, url, *fetched.URL)
}

func TestEntryRepository_CreateOrUpdate_SameHashUpdatesURL(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Test Entry"
	hash := hashString("stable-guid")
	url1 := "https://www.v2ex.com/t/1193191#reply10"
	url2 := "https://www.v2ex.com/t/1193191#reply20"

	err := repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &url1,
		Hash:   hash,
	})
	require.NoError(t, err)

	err = repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &url2,
		Hash:   hash,
	})
	require.NoError(t, err)

	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.NotNil(t, entries[0].URL)
	require.Equal(t, url2, *entries[0].URL)
}

func TestEntryRepository_CreateOrUpdate_UpgradesLegacyURLHashToGUIDHash(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})
	title := "Test Entry"
	legacyURL := "https://example.com/post"
	legacyHash := hashString(legacyURL)
	guidHash := hashString("guid-abc-123")

	testutil.SeedEntry(t, db, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &legacyURL,
		Hash:   legacyHash,
	})

	err := repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &legacyURL,
		Hash:   guidHash,
	})
	require.NoError(t, err)

	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, guidHash, entries[0].Hash)
}

func TestEntryRepository_CreateOrUpdate_UpgradesLegacyURLHashToGUIDHash_WhenFragmentChanges(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})
	title := "Test Entry"
	legacyURL := "https://www.v2ex.com/t/1193191#reply10"
	newURL := "https://www.v2ex.com/t/1193191#reply20"
	legacyHash := hashString(legacyURL)
	guidHash := hashString("v2ex-guid-1193191")

	testutil.SeedEntry(t, db, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &legacyURL,
		Hash:   legacyHash,
	})

	err := repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &newURL,
		Hash:   guidHash,
	})
	require.NoError(t, err)

	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, guidHash, entries[0].Hash)
	require.NotNil(t, entries[0].URL)
	require.Equal(t, newURL, *entries[0].URL)
}

func TestEntryRepository_CreateOrUpdate_CompatibilitySkipsWhenTargetHashExists(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})
	title := "Test Entry"
	newURL := "https://www.v2ex.com/t/1193191#reply20"
	legacyURL := "https://www.v2ex.com/t/1193191#reply10"
	guidHash := hashString("v2ex-guid-1193191")

	// Existing target hash row.
	testutil.SeedEntry(t, db, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &newURL,
		Hash:   guidHash,
	})
	// Legacy URL-hash row that used to trigger compatibility update conflicts.
	testutil.SeedEntry(t, db, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &legacyURL,
		Hash:   hashString(legacyURL),
	})

	err := repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Title:  &title,
		URL:    &newURL,
		Hash:   guidHash,
	})
	require.NoError(t, err)
}

func TestEntryRepository_List_Filters(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	folderID := testutil.SeedFolder(t, db, "F1", nil, "article")
	feedID1 := testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "u1", FolderID: &folderID})
	feedID2 := testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "u2"})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID1, Title: stringPtr("E1"), Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID1, Title: stringPtr("E2"), Read: true})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID2, Title: stringPtr("E3"), Starred: true})

	// Unread only
	entries, err := repo.List(ctx, repository.EntryListFilter{UnreadOnly: true})
	require.NoError(t, err)
	require.Len(t, entries, 2) // E1, E3

	// Starred only
	entries, err = repo.List(ctx, repository.EntryListFilter{StarredOnly: true})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "E3", *entries[0].Title)

	// By Folder
	entries, err = repo.List(ctx, repository.EntryListFilter{FolderID: &folderID})
	require.NoError(t, err)
	require.Len(t, entries, 2) // E1, E2
}

// 文件夹多选：FolderIDs 应同时命中多个文件夹下的订阅，并排除未归类的订阅。
func TestEntryRepository_List_MultiFolderIDs(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	folderA := testutil.SeedFolder(t, db, "FA", nil, "article")
	folderB := testutil.SeedFolder(t, db, "FB", nil, "article")
	feedA := testutil.SeedFeed(t, db, model.Feed{Title: "Feed A", URL: "ua", FolderID: &folderA})
	feedB := testutil.SeedFeed(t, db, model.Feed{Title: "Feed B", URL: "ub", FolderID: &folderB})
	feedNone := testutil.SeedFeed(t, db, model.Feed{Title: "Feed None", URL: "un"})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedA, Title: stringPtr("EA")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedB, Title: stringPtr("EB")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedNone, Title: stringPtr("EN")})

	entries, err := repo.List(ctx, repository.EntryListFilter{FolderIDs: []int64{folderA, folderB}})
	require.NoError(t, err)
	require.Len(t, entries, 2)
	titles := map[string]bool{}
	for _, e := range entries {
		titles[*e.Title] = true
	}
	require.True(t, titles["EA"])
	require.True(t, titles["EB"])
	require.False(t, titles["EN"])

	// 只选一个文件夹也应只命中该文件夹下的订阅。
	entries, err = repo.List(ctx, repository.EntryListFilter{FolderIDs: []int64{folderB}})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "EB", *entries[0].Title)
}

// 选中父文件夹时，条目应覆盖其所有后代（多级子文件夹）里的订阅，而不只是直接子级。
func TestEntryRepository_List_FolderIncludesDescendants(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	root := testutil.SeedFolder(t, db, "Root", nil, "article")
	child := testutil.SeedFolder(t, db, "Child", &root, "article")
	grandchild := testutil.SeedFolder(t, db, "Grand", &child, "article")
	sibling := testutil.SeedFolder(t, db, "Sibling", nil, "article")

	feedRoot := testutil.SeedFeed(t, db, model.Feed{Title: "FR", URL: "fr", FolderID: &root})
	feedGrand := testutil.SeedFeed(t, db, model.Feed{Title: "FG", URL: "fg", FolderID: &grandchild})
	feedSibling := testutil.SeedFeed(t, db, model.Feed{Title: "FS", URL: "fs", FolderID: &sibling})
	feedNone := testutil.SeedFeed(t, db, model.Feed{Title: "FN", URL: "fn"})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedRoot, Title: stringPtr("E-root")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedGrand, Title: stringPtr("E-grand")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedSibling, Title: stringPtr("E-sibling")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedNone, Title: stringPtr("E-none")})

	// 根文件夹：自身 feed + 孙级 feed 都命中；同级与未归类不命中。
	entries, err := repo.List(ctx, repository.EntryListFilter{FolderID: &root})
	require.NoError(t, err)
	titles := map[string]bool{}
	for _, e := range entries {
		titles[*e.Title] = true
	}
	require.Len(t, entries, 2)
	require.True(t, titles["E-root"])
	require.True(t, titles["E-grand"])
	require.False(t, titles["E-sibling"])
	require.False(t, titles["E-none"])

	// 子文件夹作为选中根时，也应继续向下覆盖到孙级。
	entries, err = repo.List(ctx, repository.EntryListFilter{FolderID: &child})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "E-grand", *entries[0].Title)
}

// 文件夹多选同样要覆盖整棵子树：过滤器/视图编辑器保存的范围走 FolderIDs，
// 若只做直接匹配，会与单选文件夹（子树）语义分叉。
func TestEntryRepository_List_MultiFolderIDsIncludeDescendants(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	root := testutil.SeedFolder(t, db, "Root", nil, "article")
	child := testutil.SeedFolder(t, db, "Child", &root, "article")
	grand := testutil.SeedFolder(t, db, "Grand", &child, "article")
	sibling := testutil.SeedFolder(t, db, "Sibling", nil, "article")

	feedRoot := testutil.SeedFeed(t, db, model.Feed{Title: "FR", URL: "fr", FolderID: &root})
	feedGrand := testutil.SeedFeed(t, db, model.Feed{Title: "FG", URL: "fg", FolderID: &grand})
	feedSibling := testutil.SeedFeed(t, db, model.Feed{Title: "FS", URL: "fs", FolderID: &sibling})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedRoot, Title: stringPtr("E-root")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedGrand, Title: stringPtr("E-grand")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedSibling, Title: stringPtr("E-sibling")})

	// FolderIDs = [root]：根自身 + 孙级都命中，同级不命中。
	entries, err := repo.List(ctx, repository.EntryListFilter{FolderIDs: []int64{root}})
	require.NoError(t, err)
	require.Len(t, entries, 2)
	titles := map[string]bool{}
	for _, e := range entries {
		titles[*e.Title] = true
	}
	require.True(t, titles["E-root"])
	require.True(t, titles["E-grand"])
	require.False(t, titles["E-sibling"])

	// FolderIDs = [child, sibling]：child 继续向下覆盖孙级，root 的条目不再命中。
	entries, err = repo.List(ctx, repository.EntryListFilter{FolderIDs: []int64{child, sibling}})
	require.NoError(t, err)
	titles = map[string]bool{}
	for _, e := range entries {
		titles[*e.Title] = true
	}
	require.Len(t, entries, 2)
	require.True(t, titles["E-grand"])
	require.True(t, titles["E-sibling"])
	require.False(t, titles["E-root"])
}

// parent_id 历史数据成环时，递归 CTE 必须能终止（UNION 去重），不能死循环。
func TestEntryRepository_List_FolderCycleTerminates(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	a := testutil.SeedFolder(t, db, "A", nil, "article")
	b := testutil.SeedFolder(t, db, "B", &a, "article")
	// 制造 a.parent_id = b 的环。
	_, err := db.ExecContext(ctx, `UPDATE folders SET parent_id = ? WHERE id = ?`, b, a)
	require.NoError(t, err)

	feedA := testutil.SeedFeed(t, db, model.Feed{Title: "FA", URL: "fa", FolderID: &a})
	feedB := testutil.SeedFeed(t, db, model.Feed{Title: "FB", URL: "fb", FolderID: &b})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedA, Title: stringPtr("E-a")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedB, Title: stringPtr("E-b")})

	entries, err := repo.List(ctx, repository.EntryListFilter{FolderID: &a})
	require.NoError(t, err)
	require.Len(t, entries, 2)
}

// 文件夹子树混有不同内容类型时，列表与「全部标为已读」都要按 contentType 收窄，
// 否则中栏列表是全部类型、头部未读数只算当前类型，出现「条数与数量对不上」。
func TestEntryRepository_FolderContentTypeScopesListAndMarkAll(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	root := testutil.SeedFolder(t, db, "Root", nil, "article")
	child := testutil.SeedFolder(t, db, "Child", &root, "social")
	feedArticle := testutil.SeedFeed(t, db, model.Feed{Title: "FA", URL: "fa", FolderID: &root, Type: "article"})
	feedSocial := testutil.SeedFeed(t, db, model.Feed{Title: "FS", URL: "fs", FolderID: &child, Type: "social"})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedArticle, Title: stringPtr("E-art"), Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedSocial, Title: stringPtr("E-soc"), Read: false})

	articleType := "article"
	socialType := "social"

	entries, err := repo.List(ctx, repository.EntryListFilter{FolderID: &root, ContentType: &articleType})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "E-art", *entries[0].Title)

	entries, err = repo.List(ctx, repository.EntryListFilter{FolderID: &root, ContentType: &socialType})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "E-soc", *entries[0].Title)

	// 只清 article：social 仍有未读，不能被顺带清掉。
	err = repo.MarkAllAsRead(ctx, nil, &root, &articleType)
	require.NoError(t, err)
	counts, err := repo.GetAllUnreadCounts(ctx)
	require.NoError(t, err)
	require.Len(t, counts, 1)
	require.Equal(t, feedSocial, counts[0].FeedID)
	require.Equal(t, 1, counts[0].Count)
}

func TestEntryRepository_UpdateStatus(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})
	entryID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false, Starred: false})

	// Mark read
	err := repo.UpdateReadStatus(ctx, entryID, true)
	require.NoError(t, err)
	fetched, _ := repo.GetByID(ctx, entryID)
	require.True(t, fetched.Read)

	// Mark starred
	err = repo.UpdateStarredStatus(ctx, entryID, true)
	require.NoError(t, err)
	fetched, _ = repo.GetByID(ctx, entryID)
	require.True(t, fetched.Starred)
}

func TestEntryRepository_UpdateManyReadStatus(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})
	entryID1 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false})
	entryID2 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false})
	entryID3 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false})

	err := repo.UpdateManyReadStatus(ctx, []int64{entryID1, entryID2}, true)
	require.NoError(t, err)

	fetched1, err := repo.GetByID(ctx, entryID1)
	require.NoError(t, err)
	fetched2, err := repo.GetByID(ctx, entryID2)
	require.NoError(t, err)
	fetched3, err := repo.GetByID(ctx, entryID3)
	require.NoError(t, err)

	require.True(t, fetched1.Read)
	require.True(t, fetched2.Read)
	require.False(t, fetched3.Read)

	err = repo.UpdateManyReadStatus(ctx, []int64{entryID1}, false)
	require.NoError(t, err)

	fetched1, err = repo.GetByID(ctx, entryID1)
	require.NoError(t, err)
	require.False(t, fetched1.Read)
}

func TestEntryRepository_MarkAllAsRead(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID1 := testutil.SeedFeed(t, db, model.Feed{Title: "F1", URL: "u1"})
	feedID2 := testutil.SeedFeed(t, db, model.Feed{Title: "F2", URL: "u2"})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID1, Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID2, Read: false})

	err := repo.MarkAllAsRead(ctx, &feedID1, nil, nil)
	require.NoError(t, err)

	counts, _ := repo.GetAllUnreadCounts(ctx)
	require.Len(t, counts, 1)
	require.Equal(t, feedID2, counts[0].FeedID)
	require.Equal(t, 1, counts[0].Count)
}

// 选中文件夹「全部标为已读」应覆盖整棵子树，而不只是直接子级。
func TestEntryRepository_MarkAllAsRead_FolderIncludesDescendants(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	root := testutil.SeedFolder(t, db, "Root", nil, "article")
	child := testutil.SeedFolder(t, db, "Child", &root, "article")
	grand := testutil.SeedFolder(t, db, "Grand", &child, "article")
	other := testutil.SeedFolder(t, db, "Other", nil, "article")

	feedRoot := testutil.SeedFeed(t, db, model.Feed{Title: "FR", URL: "fr", FolderID: &root})
	feedChild := testutil.SeedFeed(t, db, model.Feed{Title: "FC", URL: "fc", FolderID: &child})
	feedGrand := testutil.SeedFeed(t, db, model.Feed{Title: "FG", URL: "fg", FolderID: &grand})
	feedOther := testutil.SeedFeed(t, db, model.Feed{Title: "FO", URL: "fo", FolderID: &other})

	testutil.SeedEntry(t, db, model.Entry{FeedID: feedRoot, Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedChild, Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedGrand, Read: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedOther, Read: false})

	err := repo.MarkAllAsRead(ctx, nil, &root, nil)
	require.NoError(t, err)

	// 根、子、孙三级的未读都被清掉，只剩 other 文件夹 1 条未读。
	// （只覆盖「根 + 直接子级」的实现会漏掉 grand，这条断言会变红。）
	counts, _ := repo.GetAllUnreadCounts(ctx)
	require.Len(t, counts, 1)
	require.Equal(t, feedOther, counts[0].FeedID)
	require.Equal(t, 1, counts[0].Count)
}

func TestEntryRepository_ClearCaches(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	// 四种条目：已读未收藏（应删）、已读已收藏、未读未收藏、未读已收藏（后三者都保留）。
	deletedID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: true, Starred: false, ReadableContent: stringPtr("content")})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: true, Starred: true})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false, Starred: false})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false, Starred: true})

	// Clear readable（只清正文，不删条目）
	count, err := repo.ClearAllReadableContent(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	// Delete read & unstarred：只删「已读未收藏」一条
	count, err = repo.DeleteReadUnstarred(ctx, nil, nil)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	entries, _ := repo.List(ctx, repository.EntryListFilter{})
	require.Len(t, entries, 3)

	// 剩余三条都在：已读已收藏、未读未收藏、未读已收藏；「已读未收藏」已被删除。
	var readStarred, unreadUnstarred, unreadStarred int
	for _, e := range entries {
		require.False(t, e.Read && !e.Starred, "read+unstarred entry should have been deleted")
		switch {
		case e.Read && e.Starred:
			readStarred++
		case !e.Read && !e.Starred:
			unreadUnstarred++
		case !e.Read && e.Starred:
			unreadStarred++
		}
	}
	require.Equal(t, 1, readStarred)
	require.Equal(t, 1, unreadUnstarred) // 未读未收藏必须保留
	require.Equal(t, 1, unreadStarred)

	// 墓碑表：只有被删的那一条留下指纹（feed_id + hash），其余三条没有墓碑。
	var tombCount int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM entry_tombstones`).Scan(&tombCount))
	require.Equal(t, 1, tombCount)
	var tombFeedID int64
	var tombHash string
	require.NoError(t, db.QueryRowContext(ctx, `SELECT feed_id, hash FROM entry_tombstones`).Scan(&tombFeedID, &tombHash))
	require.Equal(t, feedID, tombFeedID)
	require.Equal(t, hashString(fmt.Sprintf("seed-entry-id:%d", deletedID)), tombHash)
}

// TestEntryRepository_TombstoneBlocksReinsertAfterPurge 清理已读缓存后，同一文章再入库必须被墓碑挡住、
// 不重新插入（否则会以 read 默认 0 回流成未读）；同 feed 的新文章不受影响。
func TestEntryRepository_TombstoneBlocksReinsertAfterPurge(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	title := "Read Article"
	url := "https://example.com/a"
	hash := hashString(url)
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Title: &title, URL: &url, Hash: hash, Read: true, Starred: false})

	count, err := repo.DeleteReadUnstarred(ctx, nil, nil)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	// 1) 同 feed 同 hash 同 url：命中墓碑，跳过、不写库。
	written, err := repo.CreateOrUpdateSkippingTombstones(ctx, model.Entry{FeedID: feedID, Title: &title, URL: &url, Hash: hash})
	require.NoError(t, err)
	require.False(t, written)
	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Empty(t, entries)

	// 2) 同 feed 同 url 但 hash 变了（如 GUID 变化）：仍应按规范化 url 命中墓碑。
	otherHash := hashString("another-guid")
	written, err = repo.CreateOrUpdateSkippingTombstones(ctx, model.Entry{FeedID: feedID, Title: &title, URL: &url, Hash: otherHash})
	require.NoError(t, err)
	require.False(t, written)

	// 3) 同 feed 不同 url/hash 的新条目：正常写入。
	newURL := "https://example.com/b"
	newHash := hashString(newURL)
	newTitle := "Fresh Article"
	written, err = repo.CreateOrUpdateSkippingTombstones(ctx, model.Entry{FeedID: feedID, Title: &newTitle, URL: &newURL, Hash: newHash})
	require.NoError(t, err)
	require.True(t, written)
	entries, err = repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, newURL, *entries[0].URL)
}

func TestEntryRepository_TombstoneNormalizesURLAndExpiresOld(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})

	// 200 天前的旧墓碑应在下一次清理时被清掉；新墓碑的 url 要去掉 fragment 后入库。
	oldCreated := time.Now().Add(-200 * 24 * time.Hour).UTC().Format(time.RFC3339)
	_, err := db.ExecContext(ctx,
		`INSERT INTO entry_tombstones (feed_id, hash, url, created_at) VALUES (?, ?, ?, ?)`,
		feedID, "old-hash", "https://example.com/old", oldCreated,
	)
	require.NoError(t, err)

	title := "Read URL With Fragment"
	rawURL := "https://example.com/a#section-2"
	hash := hashString("some-guid")
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Title: &title, URL: &rawURL, Hash: hash, Read: true, Starred: false})

	tombstoneCutoff := time.Now().AddDate(0, 0, -180)
	_, err = repo.DeleteReadUnstarred(ctx, nil, &tombstoneCutoff)
	require.NoError(t, err)

	var oldCount int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM entry_tombstones WHERE hash = 'old-hash'`).Scan(&oldCount))
	require.Equal(t, 0, oldCount)

	var storedURL string
	require.NoError(t, db.QueryRowContext(ctx, `SELECT url FROM entry_tombstones WHERE feed_id = ? AND hash = ?`, feedID, hash).Scan(&storedURL))
	require.Equal(t, "https://example.com/a", storedURL)

	// 同 URL（无 fragment）、hash 变化的新抓取仍应命中墓碑被挡住。
	written, err := repo.CreateOrUpdateSkippingTombstones(ctx, model.Entry{
		FeedID: feedID, Title: &title, URL: stringPtr("https://example.com/a"), Hash: hashString("changed-guid"),
	})
	require.NoError(t, err)
	require.False(t, written)
}

func TestEntryRepository_ExistsByHash(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryURL := "https://example.com/entry"
	entryHash := hashString(entryURL)
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, URL: &entryURL, Hash: entryHash})

	exists, err := repo.ExistsByHash(ctx, feedID, entryHash)
	require.NoError(t, err)
	require.True(t, exists)

	exists, err = repo.ExistsByHash(ctx, feedID, hashString("https://example.com/missing"))
	require.NoError(t, err)
	require.False(t, exists)
}

func TestEntryRepository_ExistsByLegacyURL(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	legacyURL := "https://www.v2ex.com/t/1193191#reply10"
	testutil.SeedEntry(t, db, model.Entry{
		FeedID: feedID,
		URL:    &legacyURL,
		Hash:   hashString(legacyURL),
	})

	exists, err := repo.ExistsByLegacyURL(ctx, feedID, "https://www.v2ex.com/t/1193191#reply20", hashString("v2ex-guid-1193191"))
	require.NoError(t, err)
	require.True(t, exists)

	exists, err = repo.ExistsByLegacyURL(ctx, feedID, "https://www.v2ex.com/t/other#reply1", hashString("other-guid"))
	require.NoError(t, err)
	require.False(t, exists)
}

func TestEntryRepository_UpdateReadableContent(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	err := repo.UpdateReadableContent(ctx, entryID, "<article>readable</article>")
	require.NoError(t, err)

	entry, err := repo.GetByID(ctx, entryID)
	require.NoError(t, err)
	require.NotNil(t, entry.ReadableContent)
	require.Equal(t, "<article>readable</article>", *entry.ReadableContent)
}

func TestEntryRepository_GetStarredCount(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Starred: true})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Starred: false})

	count, err := repo.GetStarredCount(ctx, nil)
	require.NoError(t, err)
	require.Equal(t, 1, count)

	// 按内容类型数（侧栏「只显示当前内容类型的星标」那一档）：
	// 种子订阅默认就是 article 类型，所以这一档应数到 1；换个类型就是 0
	article := "article"
	onlyArticle, err := repo.GetStarredCount(ctx, &article)
	require.NoError(t, err)
	require.Equal(t, 1, onlyArticle)

	social := "social"
	onlySocial, err := repo.GetStarredCount(ctx, &social)
	require.NoError(t, err)
	require.Equal(t, 0, onlySocial)
}

func TestParseTimePtr(t *testing.T) {
	require.Nil(t, repository.ParseTimePtr(""))

	ts := "2025-01-04T12:34:56Z"
	got := repository.ParseTimePtr(ts)
	require.NotNil(t, got)
	require.Equal(t, ts, got.UTC().Format(time.RFC3339))
}

// TestEntryRepository_CreateOrUpdate_PreservesExistingPublishedAt tests the BUG fix:
// When an entry is updated (via ON CONFLICT), the existing published_at should be
// preserved using COALESCE, not overwritten by the new value.
// See commit 4b9dbc0: fix: Refresh should not overwrite existing published_at
func TestEntryRepository_CreateOrUpdate_PreservesExistingPublishedAt(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Test Entry"
	url := "https://example.com/entry"
	originalTime := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)

	// Create entry with published_at
	entry := model.Entry{
		FeedID:      feedID,
		Title:       &title,
		URL:         &url,
		Hash:        hashString(url),
		PublishedAt: &originalTime,
	}
	err := repo.CreateOrUpdate(ctx, entry)
	require.NoError(t, err)

	// Update the same entry with a different published_at
	newTime := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	updatedEntry := model.Entry{
		FeedID:      feedID,
		Title:       &title,
		URL:         &url,
		Hash:        hashString(url),
		PublishedAt: &newTime,
	}
	err = repo.CreateOrUpdate(ctx, updatedEntry)
	require.NoError(t, err)

	// Verify that the original published_at is preserved
	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.NotNil(t, entries[0].PublishedAt)
	require.Equal(t, originalTime.Format(time.RFC3339), entries[0].PublishedAt.UTC().Format(time.RFC3339))
}

// TestEntryRepository_CreateOrUpdate_SetsPublishedAtWhenNull tests the BUG fix:
// When an entry is updated and the existing published_at is NULL, the new value
// should be used (COALESCE returns the first non-NULL value).
// See commit 4b9dbc0: fix: Refresh should not overwrite existing published_at
func TestEntryRepository_CreateOrUpdate_SetsPublishedAtWhenNull(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Test Entry"
	url := "https://example.com/entry"

	// Create entry without published_at
	entry := model.Entry{
		FeedID:      feedID,
		Title:       &title,
		URL:         &url,
		Hash:        hashString(url),
		PublishedAt: nil,
	}
	err := repo.CreateOrUpdate(ctx, entry)
	require.NoError(t, err)

	// Verify entry has no published_at
	entries, err := repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Nil(t, entries[0].PublishedAt)

	// Update the same entry with a published_at
	newTime := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	updatedEntry := model.Entry{
		FeedID:      feedID,
		Title:       &title,
		URL:         &url,
		Hash:        hashString(url),
		PublishedAt: &newTime,
	}
	err = repo.CreateOrUpdate(ctx, updatedEntry)
	require.NoError(t, err)

	// Verify that the new published_at is set
	entries, err = repo.List(ctx, repository.EntryListFilter{FeedID: &feedID})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.NotNil(t, entries[0].PublishedAt)
	require.Equal(t, newTime.Format(time.RFC3339), entries[0].PublishedAt.UTC().Format(time.RFC3339))
}

func stringPtr(s string) *string {
	return &s
}

func hashString(input string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(input)))
	return hex.EncodeToString(sum[:])
}

// 1123：按保留期清理 —— 只删「最近阅读/更新时间早于 N 天」的已读未收藏，近期的保留；
// 墓碑只覆盖本次真正删除的那批（近期保留的文章不打墓碑）。
func TestEntryRepository_DeleteReadUnstarredHonorsEntryRetention(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})

	oldURL := "https://example.com/old"
	recentURL := "https://example.com/recent"
	oldID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: true, Starred: false, URL: stringPtr(oldURL)})
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: true, Starred: false, URL: stringPtr(recentURL)})
	starredID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: true, Starred: true, URL: stringPtr("https://example.com/starred")})
	unreadID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Read: false, Starred: false, URL: stringPtr("https://example.com/unread")})

	// 把「旧的已读」「已收藏」「未读」三条的读写时间挪到 40 天前（近期那条保持 now）。
	old := time.Now().AddDate(0, 0, -40).UTC().Format(time.RFC3339)
	for _, id := range []int64{oldID, starredID, unreadID} {
		_, err := db.ExecContext(ctx, `UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?`, old, old, id)
		require.NoError(t, err)
	}

	cutoff := time.Now().AddDate(0, 0, -30)
	deleted, err := repo.DeleteReadUnstarred(ctx, &cutoff, nil)
	require.NoError(t, err)
	require.Equal(t, int64(1), deleted, "只删超过 30 天的已读未收藏")

	entries, err := repo.List(ctx, repository.EntryListFilter{})
	require.NoError(t, err)
	require.Len(t, entries, 3)
	var haveRecent bool
	for _, e := range entries {
		if e.URL != nil && *e.URL == recentURL {
			haveRecent = true
		}
		require.False(t, e.Read && !e.Starred && e.URL != nil && *e.URL == oldURL, "40 天前的已读未收藏应被删除")
	}
	require.True(t, haveRecent, "近期的已读未收藏必须保留")

	var tombCount int
	require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM entry_tombstones`).Scan(&tombCount))
	require.Equal(t, 1, tombCount, "墓碑只覆盖本次真正删除的那批")
	var tombHash string
	require.NoError(t, db.QueryRowContext(ctx, `SELECT hash FROM entry_tombstones`).Scan(&tombHash))
	require.Equal(t, hashString(oldURL), tombHash)
}
