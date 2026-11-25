import { QueryClient } from "@tanstack/react-query";
import { PERSIST_MAX_AGE } from "@/lib/query-persist";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // 29：持久化缓存恢复后要能「立刻可用并在后台重拉」。
      // gcTime 必须 >= 持久化 maxAge（都是 24h），否则刚恢复、还没被观察的查询会被
      // 5 分钟默认 gcTime 立刻回收，本地优先就失效了。
      gcTime: PERSIST_MAX_AGE,
    },
  },
});
