import { create } from "zustand";

interface VideoPreviewState {
  isOpen: boolean;
  src: string | null;
  poster: string | null;
  /** 从哪来的视频（用于播放位置记忆/标题之类的扩展，当前只用于 key） */
  originKey: string | null;

  open: (src: string, poster?: string | null, originKey?: string | null) => void;
  close: () => void;
}

/**
 * 大屏播放器状态。
 *
 * 卡片/详情里点视频不再就地播放，而是开一个固定层里的大播放器 ——
 * 小卡片里放大视频，进度条和音量都太挤（用户反馈：视频没法快进）。
 * 播放器用的是原生 controls；能拖动的前提是后端代理对 Range 请求回 206，
 * 见 backend/internal/service/proxy_range.go。
 */
export const useVideoPreviewStore = create<VideoPreviewState>((set) => ({
  isOpen: false,
  src: null,
  poster: null,
  originKey: null,

  open: (src, poster = null, originKey = null) =>
    set({ isOpen: true, src, poster, originKey }),
  close: () => set({ isOpen: false, src: null, poster: null, originKey: null }),
}));
