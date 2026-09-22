import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyFilterToHistory,
  createFilter,
  createFilterException,
  deleteFilter,
  listFilterMatches,
  getViewCounts,
  listFilters,
  parseFilterNaturalLanguage,
  previewFilter,
  revertFilter,
  unmuteEntry,
  updateFilter,
} from "@/api";
import type { ContentType } from "@/types/api";
import type { FilterWritePayload } from "@/types/filters";

function filtersQueryKey() {
  return ["filters"] as const;
}

/** 规则列表（按 position 升序，顺序即优先级） */
export function useFilters() {
  return useQuery({
    queryKey: filtersQueryKey(),
    queryFn: listFilters,
  });
}

interface UpdateFilterVariables {
  id: string;
  payload: FilterWritePayload;
}

/**
 * 规则写操作。
 * 任何写操作都可能改动条目上的标记（静音/已读/星标），所以一并让 entries 失效 —— 否则
 * 「刚建的规则把条目静音了」这件事要等下一次轮询才在列表里体现出来。
 */
export function useFilterMutations() {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: filtersQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["entries"] });
    queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    queryClient.invalidateQueries({ queryKey: ["starredCount"] });
  };

  const create = useMutation({
    mutationFn: (payload: FilterWritePayload) => createFilter(payload),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: UpdateFilterVariables) =>
      updateFilter(id, payload),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: ({ id, revert }: { id: string; revert?: boolean }) =>
      deleteFilter(id, revert ?? false),
    onSuccess: invalidate,
  });

  const revert = useMutation({
    mutationFn: (id: string) => revertFilter(id),
    onSuccess: invalidate,
  });

  return { create, update, remove, revert };
}

/** 干跑预览（会命中哪些、会影响多少条）—— 不写任何数据 */
export function useFilterPreview() {
  return useMutation({
    mutationFn: (variables: { payload: FilterWritePayload; limit?: number }) =>
      previewFilter(variables.payload, variables.limit ?? 200),
  });
}

/** 某条规则的命中记录（「为什么看不到这条」的依据） */
export function useFilterMatches(id: string | null, limit = 50) {
  return useQuery({
    queryKey: ["filterMatches", id, limit],
    queryFn: () => listFilterMatches(id!, limit),
    enabled: Boolean(id),
  });
}

/** 取消单条条目的静音（条目上的「取消静音」按钮用） */
export function useUnmuteEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => unmuteEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["filters"] });
      queryClient.invalidateQueries({ queryKey: ["viewCounts"] });
    },
  });
}

/** 手动回溯：把规则链补跑到历史条目上（幂等，返回扫描/应用条数） */
export function useApplyFilterHistory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { id: string; limit?: number }) =>
      applyFilterToHistory(variables.id, variables.limit ?? 500),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filters"] });
      queryClient.invalidateQueries({ queryKey: ["viewCounts"] });
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["filterMatches"] });
    },
  });
}

/**
 * 自然语言建规则：一次补全换一份规则草稿（不落库）。
 * 这里只负责拿到草稿，填进编辑器、让用户确认后再保存 —— 见 AutomationSettings 的入口。
 */
export function useFilterDraft() {
  return useMutation({
    mutationFn: (text: string) => parseFilterNaturalLanguage(text),
  });
}

/**
 * 条目级「豁免这类内容」：建例外规则 + 立刻放行这一条。
 * 放行会改条目状态（取消静音、退回未读），所以 entries / unreadCounts 也要失效。
 */
export function useCreateFilterException() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (entryId: string) => createFilterException(entryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filters"] });
      queryClient.invalidateQueries({ queryKey: ["viewCounts"] });
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["filterMatches"] });
    },
  });
}

/**
 * 每条保存视图当前命中的条目数（侧栏「视图」那一段的数量角标）。
 *
 * 后端一次扫描算出全部视图的数，所以这里一个请求就够；数要跟进当前内容类型，
 * 所以缓存键带上 contentType。条目的已读/星标、视图本身的增删改都会改变这个数，
 * 相关 mutation 里会 invalidate 这个键（见 markAsRead / useCreateFilter 等）。
 */
export function useViewCounts(contentType?: ContentType) {
  return useQuery({
    queryKey: viewCountsQueryKey(contentType),
    queryFn: () => getViewCounts(contentType),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

export function viewCountsQueryKey(contentType?: ContentType) {
  return ["viewCounts", contentType ?? "all"] as const;
}
