import { create } from "zustand";
import { ApiError, checkForUpdate } from "@/api";
import type { UpdateCheckResult } from "@/types/settings";

/**
 * 检查失败的三类原因分开说：限流要「等会儿再试」、仓库配错要「去看配置」，
 * 都塌缩成「连不上 GitHub」只会让用户一直点重试（而每次重试都真打一次 GitHub）。
 */
export type UpdateErrorKind = "rateLimited" | "notFound" | "generic";

export type UpdateCheckStatus = "idle" | "checking" | "success" | "error";

/**
 * 只按状态码分类，不匹配错误文案：文案一改前端会静默退回通用提示，两边都不报错。
 * 429 = 限流（backend/internal/handler/response.go 的 ErrUpdateRateLimited），
 * 404 = 仓库或 Release 不存在（ErrUpdateReleaseNotFound）。
 */
function classifyError(error: unknown): UpdateErrorKind {
  if (error instanceof ApiError) {
    if (error.status === 429) return "rateLimited";
    if (error.status === 404) return "notFound";
  }
  return "generic";
}

/**
 * 自动检查的最小间隔。后端有 10 分钟缓存，这里再挡一层是给「用户反复切页面」用的：
 * 每次切到主页都打一次接口没必要，结果也不会变。
 */
const MIN_INTERVAL_MS = 30 * 60 * 1000;

interface UpdateCheckState {
  status: UpdateCheckStatus;
  result: UpdateCheckResult | null;
  errorKind: UpdateErrorKind;
  errorMessage: string | null;
  /** 上次成功检查的时刻（毫秒），null = 还没成功过 */
  checkedAt: number | null;
  /**
   * 上次发起检查的时刻（毫秒），不论成败。节流看它而不是 checkedAt：
   * 限流期间若只按成功时间节流，每次打开关于页都会再打一次 GitHub，
   * 只会让限流更久。
   */
  lastAttemptAt: number | null;
  /**
   * 更新详情弹窗的开关。放在 store 里是因为有两个入口：关于页的横幅按钮、
   * 右下角提示上的「查看更新内容」——后者要先打开设置并落到「关于」页。
   */
  detailOpen: boolean;

  /**
   * 检查一次。
   * - `force: false`（默认）：30 分钟内检查过就跳过，用于进主页/进关于页的自动检查。
   * - `force: true`：跳过节流，用于用户点「检查更新」。
   * 并发调用共享同一次请求（inFlight 去重），不会打穿 GitHub 的匿名配额。
   */
  check: (options?: { force?: boolean }) => Promise<void>;
  /** 打开/关闭更新详情弹窗（关于页与右下角提示共用）。 */
  setDetailOpen: (open: boolean) => void;
  /**
   * 已经提示过（或用户已关掉）的版本号。右下角提示靠它去重：
   * 没有它，用户每次点关闭、每次重渲染都会再弹一次。
   */
  announcedVersion: string | null;
  markAnnounced: (version: string) => void;
  /** 只给测试用：把 store 恢复到初始态，避免用例之间互相污染。 */
  reset: () => void;
}

const initialState = {
  status: "idle" as UpdateCheckStatus,
  result: null,
  errorKind: "generic" as UpdateErrorKind,
  errorMessage: null,
  checkedAt: null,
  lastAttemptAt: null,
  detailOpen: false,
  announcedVersion: null,
};

/** 进行中的请求；模块级而不是 state，免得它变化触发重渲染 */
let inFlight: Promise<void> | null = null;

export const useUpdateCheckStore = create<UpdateCheckState>((set, get) => ({
  ...initialState,

  check: async (options = {}) => {
    if (inFlight) return inFlight;

    const { lastAttemptAt } = get();
    const throttled =
      lastAttemptAt !== null && Date.now() - lastAttemptAt < MIN_INTERVAL_MS;
    if (!options.force && throttled) return;

    set({
      status: "checking",
      errorMessage: null,
      lastAttemptAt: Date.now(),
    });

    inFlight = (async () => {
      try {
        const result = await checkForUpdate();
        set({
          status: "success",
          result,
          errorMessage: null,
          checkedAt: Date.now(),
        });
      } catch (error) {
        set({
          status: "error",
          errorKind: classifyError(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  },

  setDetailOpen: (open) => set({ detailOpen: open }),

  markAnnounced: (version) => set({ announcedVersion: version }),

  reset: () => {
    inFlight = null;
    set(initialState);
  },
}));
