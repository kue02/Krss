"use client";

/*
 * obsidianui hover-img 原件（https://www.obsidianui.dev/docs/hover-img），
 * 机制（gsap.quickTo 跟随、yPercent 逐行切换、scale 进出场）与文件骨架一字未改。
 *
 * 对上游的扩展，均在此标注：
 *   A. `ProjectItem` 增加可选 `iconSrc`（条目来源图标）
 *   B. 标题前渲染该图标，并用 `<span class="hover-img-title">` 包住标题文字（便于长标题截断）
 *   C. 29-3：一篇文章多图 — `ProjectItem` 新增可选 `imageSrcs`（`imageSrc` 保留做回退，不删）；
 *      同一行多图时浮块内横向滑动切换（`translateX(-i*100%)` + `transition: transform .3s`，
 *      无箭头/圆点/页码、无新依赖）。单图 / 无图渲染与原来一字一致。
 *   D. 29-4：多图切换触发开关 `multiImageConfig{rowWheel,floatWheel,hSwipe}`
 *     （PictureHoverList 从 `hoverMultiImage` 设置读出来传进来；不传 = 默认只开行上滚轮）。
 * 另有一处纯为通过本项目编译：去掉上游未使用的 `import React` 默认导入
 * （本项目 tsconfig 开了 noUnusedLocals）。外观尺寸一律由使用方的 CSS 调，不在这里改。
 */

import { useRef, useEffect, useState } from "react";
import gsap from "gsap";
import "@/components/block/hover-img.css";

export interface ProjectItem {
    title: string;
    label: string;
    imageSrc: string;
    /* krss: 条目来源图标（对上游的扩展，见文末说明） */
    iconSrc?: string;
    /* 29-3：该条目的全部图片；为空/缺省时退回 imageSrc（单图行为与原来一致） */
    imageSrcs?: string[];
}

/** 29-4：多图切换的三个触发开关（各自独立，可任意组合） */
export interface HoverMultiImageTriggers {
    /** 鼠标停在那一行上滚轮 = 切图（这一下不吃列表滚动） */
    rowWheel: boolean;
    /** 鼠标移进浮块后滚轮 = 切图（行上的滚轮仍滚列表） */
    floatWheel: boolean;
    /** 鼠标横向滑动 = 上一张 / 下一张 */
    hSwipe: boolean;
}

/** 开关没传时 = 设置默认值（只开行上滚轮，与 useUISettings 的 hoverMultiImage 默认一致） */
const DEFAULT_TRIGGERS: HoverMultiImageTriggers = {
    rowWheel: true,
    floatWheel: false,
    hSwipe: false,
};

/* 无极滚动：滚轮累加连续位移（px），停后吸附到最近一张。
 * 一格普通滚轮 deltaY≈100 × WHEEL_GAIN(1.0) = 100px ≈ 1/4 张（strip 宽 400px），
 * 即系数×100/stripWidth ≈ 0.25，落在 1/5~1/3 区间；连续手感 + 180ms 吸附落位。 */
const WHEEL_GAIN = 1.0;
const SNAP_DELAY_MS = 180;
/* jsdom 里 clientWidth 恒为 0，真机浮块宽 400px（compact 160px，用实测值优先） */
const STRIP_WIDTH_FALLBACK = 400;

/* 29-4 浮块 hover 不消失：照 RefreshTooltip 同款（关闭延迟 + 进入取消），
 * 进出场 scale 动效与鼠标跟随一字不动，只把「立刻藏」换成「延迟藏」。 */
const FLOAT_HIDE_DELAY_MS = 250;
/* 29-4 hSwipe：横向滑动切图。位移阈值 48px（小于浮块宽 400px，随手一划就触发，
 * 又不会把列表里正常的纵向移动误判）+ 350ms 冷却（横向位移和浮块跟随是同一个
 * mousemove 动作，不冷却一次划动会连翻好几张）。 */
const HSWIPE_THRESHOLD_PX = 48;
const HSWIPE_MIN_INTERVAL_MS = 350;

const defaultProjects: ProjectItem[] = [
    {
        title: "Shree Krishna",
        label: "The Supreme Personality of Godhead",
        imageSrc: "/cdn/hover-img/hover-img-img01-alt.jpg?v=3",
    },
    {
        title: "Radha Krishna",
        label: "The Divine Couple",
        imageSrc: "/cdn/hover-img/hover-img-img02.jpg?v=3",
    },
    {
        title: "Divine Love",
        label: "Eternal Bond",
        imageSrc: "/cdn/hover-img/hover-img-img03.jpg?v=3",
    },
];

interface HoverImgProps {
    projects?: ProjectItem[];
    className?: string;
    isContained?: boolean; // New prop for grid previews
    compact?: boolean; // New prop for compact layout
    /** 29-4：多图切换触发开关（不传 = 默认只开行上滚轮） */
    multiImageConfig?: HoverMultiImageTriggers;
}

/** 生效的图片列表：imageSrcs 有东西就用它，否则退回单张 imageSrc（= 原来行为） */
function effectiveImages(project: ProjectItem): string[] {
    if (project.imageSrcs && project.imageSrcs.length > 0) return project.imageSrcs;
    return [project.imageSrc];
}

export function HoverImg({ projects = defaultProjects, className, isContained = false, compact = false, multiImageConfig }: HoverImgProps) {
    const triggers = multiImageConfig ?? DEFAULT_TRIGGERS;
    const containerRef = useRef<HTMLDivElement>(null);
    const thumbnailRef = useRef<HTMLDivElement>(null);
    const xToRef = useRef<gsap.QuickToFunc | null>(null);
    const yToRef = useRef<gsap.QuickToFunc | null>(null);

    /* 29-3：当前悬停行 + 每行各看到第几张（行之间记忆位置，换行回来还在那张） */
    const [activeRow, setActiveRow] = useState(-1);
    const [imgIndexes, setImgIndexes] = useState<Record<number, number>>({});
    const activeRowRef = useRef(-1);
    /* 无极滚动：每行目标偏移 px（连续量）；imgIndexes 是它的四舍五入镜像（data-img-index 用） */
    const offsetsRef = useRef<Record<number, number>>({});
    const imgIndexesRef = useRef<Record<number, number>>({});
    imgIndexesRef.current = imgIndexes;
    const snapTimersRef = useRef<Record<number, number | undefined>>({});
    /* effect 里读最新值用的镜像（监听器只订阅一次，不跟 state 跑） */
    const countsRef = useRef<number[]>([]);
    countsRef.current = projects.map((p) => effectiveImages(p).length);
    const triggersRef = useRef(triggers);
    triggersRef.current = triggers;

    useEffect(() => {
        const projectThumbnail = thumbnailRef.current;
        const projectsContainer = containerRef.current?.querySelector(
            ".hover-img-projects"
        ) as HTMLElement | null;

        if (!projectThumbnail || !projectsContainer) return;

        const projectElements = gsap.utils.toArray(
            ".hover-img-project",
            projectsContainer
        ) as HTMLElement[];
        const thumbnails = gsap.utils.toArray(
            ".hover-img-thumbnail",
            projectThumbnail
        ) as HTMLElement[];

        gsap.set(projectThumbnail, { scale: 0, xPercent: -50, yPercent: -50 });

        xToRef.current = gsap.quickTo(projectThumbnail, "x", {
            duration: 0.4,
            ease: "power3.out",
        });
        yToRef.current = gsap.quickTo(projectThumbnail, "y", {
            duration: 0.4,
            ease: "power3.out",
        });

        /* 无极滚动的 strip 定位：gsap 补间直接改 DOM，React 不写 transform
         *（避免重渲染掐死补间）。元素按行索引用 projectThumbnail 内查询，
         * 因为 gsap.utils.toArray 的镜像数组在 React 重渲染后下标会错位。 */
        const stripOfRow = (row: number): HTMLElement | null => {
            const thumbs = projectThumbnail.querySelectorAll(".hover-img-thumbnail");
            const thumb = thumbs[row] as HTMLElement | undefined;
            return (thumb?.querySelector(".hover-img-multi") as HTMLElement | null) ?? null;
        };
        const stripWidthOf = (row: number): number => {
            const w = stripOfRow(row)?.clientWidth ?? 0;
            return w > 0 ? w : STRIP_WIDTH_FALLBACK;
        };

        /* hSwipe 专用离散步进（无极滚动不动它）：到头就停，不循环。
         * strip 位移纯由 gsap 驱动（React 不写 transform，避免重渲染掐死补间），
         * 这里直接 gsap.to 到目标张。 */
        const stepImage = (row: number, dir: 1 | -1) => {
            const n = countsRef.current[row] ?? 1;
            if (n <= 1) return;
            const cur = imgIndexesRef.current[row] ?? 0;
            /* 到头就停（不循环）：滚轮/滑动误触不会从末张跳回首张 */
            const next = Math.min(n - 1, Math.max(0, cur + dir));
            if (next === cur) return;
            const width = stripWidthOf(row);
            offsetsRef.current[row] = next * width;
            const strip = stripOfRow(row);
            if (strip) {
                gsap.to(strip, {
                    x: -next * width,
                    duration: 0.25,
                    ease: "power2.out",
                    overwrite: true,
                });
            }
            setImgIndexes((prev) => ({ ...prev, [row]: next }));
        };

        /* 无极滚动：滚轮驱动连续位移 px（不丢事件），停 180ms 后吸附到最近一张 */
        const scrollContinuous = (row: number, delta: number) => {
            const n = countsRef.current[row] ?? 1;
            if (row < 0 || n <= 1) return false;
            const width = stripWidthOf(row);
            const max = (n - 1) * width;
            const base =
                offsetsRef.current[row] ??
                (imgIndexesRef.current[row] ?? 0) * width;
            const offset = Math.min(max, Math.max(0, base + delta * WHEEL_GAIN));
            offsetsRef.current[row] = offset;
            const strip = stripOfRow(row);
            if (strip) {
                gsap.to(strip, {
                    x: -offset,
                    duration: 0.18,
                    ease: "power2.out",
                    overwrite: true,
                });
            }
            /* data-img-index 取最近一张（小幅 wheel 下仍为 0，真机读数靠它） */
            const nearest = Math.round(offset / width);
            if (nearest !== (imgIndexesRef.current[row] ?? 0)) {
                setImgIndexes((prev) => ({ ...prev, [row]: nearest }));
            }
            /* 重置吸附定时器：停下来 180ms 才落位 */
            const prev_timer = snapTimersRef.current[row];
            if (prev_timer !== undefined) window.clearTimeout(prev_timer);
            snapTimersRef.current[row] = window.setTimeout(() => {
                snapTimersRef.current[row] = undefined;
                const cur_off = offsetsRef.current[row] ?? nearest * width;
                const snapped =
                    Math.min(max, Math.max(0, Math.round(cur_off / width))) * width;
                offsetsRef.current[row] = snapped;
                const el = stripOfRow(row);
                if (el) {
                    gsap.to(el, {
                        x: -snapped,
                        duration: 0.25,
                        ease: "power2.out",
                        overwrite: true,
                    });
                }
                const snappedIdx = Math.round(snapped / width);
                if (snappedIdx !== (imgIndexesRef.current[row] ?? 0)) {
                    setImgIndexes((prev) => ({ ...prev, [row]: snappedIdx }));
                }
            }, SNAP_DELAY_MS);
            return true;
        };

        const handleMouseMove = (e: MouseEvent) => {
            let x = e.clientX;
            let y = e.clientY;

            if (isContained && containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                x = e.clientX - rect.left;
                y = e.clientY - rect.top;
            }

            xToRef.current?.(x);
            yToRef.current?.(y);
        };

        /* 29-4：浮块上的监听（floatWheel / hSwipe 都靠「鼠标能进浮块」——
         * data-float-hover 只在两开关任一开时才 auto，默认 none 浮块纯跟随）。 */
        let hideTimer: number | undefined = undefined;
        const cancelHide = () => {
            if (hideTimer !== undefined) {
                window.clearTimeout(hideTimer);
                hideTimer = undefined;
            }
        };
        const scheduleHide = () => {
            cancelHide();
            hideTimer = window.setTimeout(() => {
                hideTimer = undefined;
                gsap.to(projectThumbnail, {
                    scale: 0,
                    duration: 0.3,
                    ease: "power2.out",
                    overwrite: "auto",
                });
            }, FLOAT_HIDE_DELAY_MS);
        };

        const handleMouseLeave = () => {
            /* 29-4：浮块 hover 不消失 — 行容器 mouseleave 只起延迟藏，
             * 鼠标若已进浮块，浮块的 mouseenter 会取消这次关闭（RefreshTooltip 同款）。 */
            scheduleHide();
        };

        projectsContainer.addEventListener("mousemove", handleMouseMove);
        projectsContainer.addEventListener("mouseleave", handleMouseLeave);

        const thumbMoveState = { lastX: 0, lastFlipAt: 0, tracking: false };

        /* 浮块进入/离开：进入取消关闭（RefreshTooltip 同款，250ms 延迟关），
         * 离开浮块才起延迟关闭。行上 handleMouseEnter 会立即 scale 1 重新打开。 */
        const handleThumbMouseEnter = () => cancelHide();
        const handleThumbMouseLeave = () => scheduleHide();
        projectThumbnail.addEventListener("mouseenter", handleThumbMouseEnter);
        projectThumbnail.addEventListener("mouseleave", handleThumbMouseLeave);

        /* 29-4 floatWheel：鼠标移进浮块后滚轮 = 无极连续位移（行上的滚轮仍滚列表）。 */
        const handleThumbWheel = (e: WheelEvent) => {
            if (!triggersRef.current.floatWheel) return;
            const row = activeRowRef.current;
            const n = countsRef.current[row] ?? 1;
            if (row < 0 || n <= 1) return;
            e.preventDefault();
            e.stopPropagation();
            /* 纵向优先，横向滚轮也吃：连续 offset 不怕连发，不节流丢事件 */
            const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            scrollContinuous(row, delta);
        };
        projectThumbnail.addEventListener("wheel", handleThumbWheel, { passive: false });

        /* 29-4 hSwipe：鼠标横向滑动 = 上一张/下一张。
         * 横向位移和浮块鼠标跟随是同一个 mousemove 动作，不节流会连翻好几张：
         * 累计位移超 48px 才翻一张 + 每次翻完 350ms 冷却。 */
        const handleThumbMouseMove = (e: MouseEvent) => {
            if (!triggersRef.current.hSwipe) return;
            const row = activeRowRef.current;
            const n = countsRef.current[row] ?? 1;
            if (row < 0 || n <= 1) return;
            const now = performance.now();
            if (!thumbMoveState.tracking) {
                thumbMoveState.lastX = e.clientX;
                thumbMoveState.tracking = true;
                thumbMoveState.lastFlipAt = 0;
                return;
            }
            const dx = e.clientX - thumbMoveState.lastX;
            if (Math.abs(dx) < HSWIPE_THRESHOLD_PX) return;
            if (now - thumbMoveState.lastFlipAt < HSWIPE_MIN_INTERVAL_MS) return;
            thumbMoveState.lastFlipAt = now;
            thumbMoveState.lastX = e.clientX;
            stepImage(row, dx > 0 ? 1 : -1);
        };
        projectThumbnail.addEventListener("mousemove", handleThumbMouseMove);

        const projectListeners: Array<() => void> = [];

        /* 29-4：行之间换行也先取消旧关闭——新行的 mouseenter 会立即 scale-1 打开，
         * 避免「从行 A 移到行 B 的瞬间」旧 timer 把浮块藏一下再打开（闪）。 */
        projectElements.forEach((project, index) => {
            const handleMouseEnter = () => {
                cancelHide();
                activeRowRef.current = index;
                setActiveRow(index);
                gsap.to(projectThumbnail, {
                    scale: 1,
                    duration: 0.4,
                    ease: "power2.out",
                    overwrite: "auto",
                });

                gsap.to(thumbnails, {
                    yPercent: -100 * index,
                    duration: 0.4,
                    ease: "power2.out",
                    overwrite: "auto",
                });
            };

            /* 29-4 rowWheel：行上滚轮 = 无极连续位移。这一下必须不吃列表滚动 ——
             * wheel 默认是 passive 的（调 preventDefault 会被浏览器忽略并打 warning），
             * 所以这里用原生 addEventListener({ passive: false }) + preventDefault。
             * 开关关着 / 单图行直接 return：滚轮照常滚列表，不拦。 */
            const handleRowWheel = (e: WheelEvent) => {
                if (!triggersRef.current.rowWheel) return;
                const n = countsRef.current[index] ?? 1;
                if (n <= 1) return;
                e.preventDefault();
                e.stopPropagation();
                /* 纵向优先，横向滚轮也吃：连续 offset 接管“切几张”语义，不节流丢事件 */
                const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
                scrollContinuous(index, delta);
            };

            project.addEventListener("mouseenter", handleMouseEnter);
            project.addEventListener("wheel", handleRowWheel, { passive: false });
            projectListeners.push(() => {
                project.removeEventListener("mouseenter", handleMouseEnter);
                project.removeEventListener("wheel", handleRowWheel);
            });
        });

        return () => {
            cancelHide();
            projectsContainer.removeEventListener("mousemove", handleMouseMove);
            projectsContainer.removeEventListener("mouseleave", handleMouseLeave);
            projectThumbnail.removeEventListener("mouseenter", handleThumbMouseEnter);
            projectThumbnail.removeEventListener("mouseleave", handleThumbMouseLeave);
            projectThumbnail.removeEventListener("wheel", handleThumbWheel);
            projectThumbnail.removeEventListener("mousemove", handleThumbMouseMove);
            projectListeners.forEach((cleanup) => cleanup());
        };
    }, [projects, isContained, triggers.rowWheel, triggers.floatWheel, triggers.hSwipe]);

    return (
        <div className={`hover-img-container ${compact ? "hover-img-compact" : ""} ${className || ""}`} ref={containerRef}>
            <div className="hover-img-projects">
                {projects.map((project, index) => (
                    <div className="hover-img-project" key={index}>
                        {/* krss: 标题前加来源图标（上游只有 h2 + p） */}
                        <h2>
                            {project.iconSrc ? (
                                <img className="hover-img-icon" src={project.iconSrc} alt="" loading="lazy" />
                            ) : null}
                            <span className="hover-img-title">{project.title}</span>
                        </h2>
                        <p>{project.label}</p>
                    </div>
                ))}
            </div>

            <div
                className="hover-img-thumbnail-wrapper"
                ref={thumbnailRef}
                data-active-row={activeRow}
                /* 29-4：floatWheel/hSwipe 任一开、且行悬停中，浮块才吃指针
                 * （鼠标能进来，滚轮/横滑有地方落）；默认全 none：纯跟随预览，
                 * 永不挡列表、不盖住行（盖住会导致行 hover 闪断）。 */
                data-float-hover={activeRow >= 0 && (triggers.floatWheel || triggers.hSwipe) ? "true" : "false"}
                style={isContained ? { position: "absolute" } : undefined}
            >
                {projects.map((project, index) => {
                    const srcs = effectiveImages(project);
                    /* 单图 / 无图：与原来一字一致（一张 img，无 strip） */
                    if (srcs.length <= 1) {
                        return (
                            <div className="hover-img-thumbnail" key={index}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={project.imageSrc} alt={project.title} />
                            </div>
                        );
                    }
                    /* 多图：横向 strip，位移纯由 gsap 的 x（px 连续量）驱动，
                     * React 只写 data-img-index（= Math.round(offset/width)，真机读数靠它），
                     * 不写 inline transform，避免重渲染掐死滚轮/吸附补间。 */
                    const cur = Math.min(imgIndexes[index] ?? 0, srcs.length - 1);
                    return (
                        <div className="hover-img-thumbnail" key={index}>
                            <div
                                className="hover-img-multi"
                                data-img-index={cur}
                                data-img-count={srcs.length}
                            >
                                {srcs.map((src, si) => (
                                    /* eslint-disable-next-line @next/next/no-img-element */
                                    <img key={si} src={src} alt={project.title} loading="lazy" />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default HoverImg;
