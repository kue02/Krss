import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, EntryListParams, EntryListResponse } from "@/types/api";

vi.mock("@/api", () => ({
  listEntries: vi.fn(),
}));

import { listEntries } from "@/api";
import { syncEntriesHeads } from "./entries-head-sync";

const mockedListEntries = vi.mocked(listEntries);

function makeEntry(id: string): Entry {
  return {
    id,
    feedId: "feed-1",
    title: `Entry ${id}`,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makeResponse(ids: string[], hasMore = true): EntryListResponse {
  return { entries: ids.map(makeEntry), hasMore };
}

const params: EntryListParams = { contentType: "social", limit: 50 };
const queryKey = ["entries", params] as const;

interface Seeded {
  client: QueryClient;
  unsubscribe: () => void;
}

/** 塞入两页数据并挂一个 observer（head sync 只处理挂着的列表） */
function seedLoadedList(idsByPage: string[][]): Seeded {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKey, {
    pages: idsByPage.map((ids) => makeResponse(ids)),
    pageParams: idsByPage.map((_, index) => index * 50),
  });
  const observer = new QueryObserver(client, {
    queryKey,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { client, unsubscribe };
}

function loadedIds(client: QueryClient): string[] {
  const data = client.getQueryData<{ pages: EntryListResponse[] }>(queryKey);
  return data?.pages.flatMap((page) => page.entries.map((e) => e.id)) ?? [];
}

beforeEach(() => {
  mockedListEntries.mockReset();
  vi.restoreAllMocks();
});

describe("syncEntriesHeads", () => {
  it("把头部新条目并入第一页，其余已加载页原样不动", async () => {
    const { client, unsubscribe } = seedLoadedList([
      ["30", "31", "32"],
      ["33", "34"],
    ]);
    // 头部新增 3 条（1、2、3）后，服务端第 0 页变成 1,2,3,30,31
    mockedListEntries.mockResolvedValueOnce(makeResponse(["1", "2", "3", "30", "31"]));

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 1, added: 3, reloads: 0 });
    expect(loadedIds(client)).toEqual([
      "1",
      "2",
      "3",
      "30",
      "31",
      "32",
      "33",
      "34",
    ]);
    const secondPage = client.getQueryData<{ pages: EntryListResponse[] }>(
      queryKey,
    )?.pages[1];
    expect(secondPage?.entries.map((e) => e.id)).toEqual(["33", "34"]);
    unsubscribe();
  });

  it("头部没新增时什么都不改，只问一次接口", async () => {
    const { client, unsubscribe } = seedLoadedList([["30", "31"], ["32"]]);
    mockedListEntries.mockResolvedValueOnce(makeResponse(["30", "31"]));

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 1, added: 0, reloads: 0 });
    expect(loadedIds(client)).toEqual(["30", "31", "32"]);
    expect(mockedListEntries).toHaveBeenCalledTimes(1);
    expect(mockedListEntries).toHaveBeenCalledWith({ ...params, offset: 0 });
    unsubscribe();
  });

  it("新增条目跨页时继续往前翻，直到撞见已有条目", async () => {
    const { client, unsubscribe } = seedLoadedList([["300", "301"]]);
    mockedListEntries
      .mockResolvedValueOnce(makeResponse(["1", "2"]))
      .mockResolvedValueOnce(makeResponse(["3", "300"]));

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 1, added: 3, reloads: 0 });
    expect(loadedIds(client)).toEqual(["1", "2", "3", "300", "301"]);
    expect(mockedListEntries).toHaveBeenNthCalledWith(2, { ...params, offset: 2 });
    unsubscribe();
  });

  it("一直翻不到已有条目（列表被整体换掉）时退回整窗重拉", async () => {
    const { client, unsubscribe } = seedLoadedList([["30", "31"]]);
    mockedListEntries
      .mockResolvedValueOnce(makeResponse(["900", "901"]))
      .mockResolvedValueOnce(makeResponse(["902", "903"], false));
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 1, added: 0, reloads: 1 });
    expect(loadedIds(client)).toEqual(["30", "31"]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    unsubscribe();
  });

  it("列表为空时直接重拉，不并入任何东西", async () => {
    const { client, unsubscribe } = seedLoadedList([[]]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 0, added: 0, reloads: 1 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    expect(mockedListEntries).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("没有挂着的列表时一次接口都不打", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKey, {
      pages: [makeResponse(["1", "2"])],
      pageParams: [0],
    });

    const summary = await syncEntriesHeads(client);

    expect(summary).toEqual({ queries: 0, added: 0, reloads: 0 });
    expect(mockedListEntries).not.toHaveBeenCalled();
  });
});