import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUISettingKey } from "@/hooks/useUISettings";
import {
  PUSH_ANIMATE,
  PUSH_EXIT_WITH_ENTRY,
  PUSH_INITIAL,
  PUSH_TRANSITION,
  SLIDE_ANIMATE,
  SLIDE_ANIMATE_OPACITY_DELAY,
  SLIDE_EXIT,
  SLIDE_INITIAL,
  SLIDE_TRANSITION,
  pushPaneKey,
} from "./reader-transition";

interface EntryContentTransitionProps {
  /** 当前选中的条目 id（null = 还没选过任何条目） */
  entryId: string | null;
  children: ReactNode;
}

/**
 * 桌面三栏 · 第三栏（正文区）的转场 —— 对齐 Nextflux
 * `docs/references/nextflux/src/components/ArticleView/ArticleView.jsx` L146-202。
 *
 * 两层嵌套，各管一套：
 * - 外层（推进）：`key={entryId ? "content" : "empty"}` —— 只在 null ↔ 有值时切换，
 *   整块从右侧推入（`x: "100vw"` → 0，L155-173）；切换文章时 key 不变，外层不动。
 * - 内层（滑动）：`key={entryId}` + `mode="wait"` —— 每次换 id 都触发，
 *   正文从下方 50px 滑入、上方 -50px 滑出（L190-202），无方向反转。
 *
 * Nextflux 的空态是它自己的 EmptyPlaceholder；krss 的空态（children 传进来的
 * Placeholder）语义不变，这里只包动画层。
 */
export function EntryContentTransition({
  entryId,
  children,
}: EntryContentTransitionProps) {
  const reduceMotion = useUISettingKey("reduceMotion");

  return (
    /**
     * mode="wait" 而不是 Nextflux 桌面端的 popLayout：
     * 本项目的第三栏是正常文档流，且「悬停大图」档下还伴随整列由 0 宽展开
     * （见 ThreeColumnLayout 的 hideContent）—— 宽度与转场同时变化会让
     * popLayout 的脱流测量失效，两个 pane 一起占流、各被压成一半（实测
     * h 473,473 对 945）。wait 是「旧 pane 退完再进新 pane」，不依赖脱流，
     * 在宽度变化下同样稳。空态 pane 的 exit 是瞬时的（见下），所以不等待。
     * 内层（换文章）本来就是 Nextflux 的 mode="wait"，两层口径一致。
     */
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={pushPaneKey(entryId)}
        className="h-full min-h-0 w-full"
        data-transition-pane={pushPaneKey(entryId)}
        initial={PUSH_INITIAL}
        animate={PUSH_ANIMATE}
        exit={
          entryId
            ? { ...PUSH_EXIT_WITH_ENTRY, transition: { ...PUSH_TRANSITION } }
            : /* 空态（占位）退场不占观感：它在收起态本来就被收成 0 宽、看不见，
                 瞬时退掉即可，免得 wait 下推进前先干等半秒。
                 必须显式 type:"tween" —— spring 会忽略 duration，实测会拖到 945ms。 */
              { opacity: 0, transition: { duration: 0, type: "tween" } }
        }
        transition={reduceMotion ? { duration: 0 } : { ...PUSH_TRANSITION }}
        style={{ willChange: "transform" }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={entryId ?? "empty"}
            className="h-full min-h-0 w-full"
            data-transition-slide={entryId ?? "empty"}
            initial={reduceMotion ? {} : { ...SLIDE_INITIAL }}
            animate={{
              ...SLIDE_ANIMATE,
              transition: { opacity: { delay: SLIDE_ANIMATE_OPACITY_DELAY } },
            }}
            exit={reduceMotion ? {} : { ...SLIDE_EXIT }}
            transition={reduceMotion ? { duration: 0 } : { ...SLIDE_TRANSITION }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
