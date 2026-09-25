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

/* 滚轮连发节流：触控板一次手势会打出几十个 wheel 事件，不节流会连翻好几张 */
const WHEEL_MIN_INTERVAL_MS = 120;

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

        const stepImage = (row: number, dir: 1 | -1) => {
            const n = countsRef.current[row] ?? 1;
            if (n <= 1) return;
            setImgIndexes((prev) => {
                const cur = prev[row] ?? 0;
                /* 到头就停（不循环）：滚轮/滑动误触不会从末张跳回首张 */
                const next = Math.min(n - 1, Math.max(0, cur + dir));
                if (next === cur) return prev;
                return { ...prev, [row]: next };
            });
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

        const handleMouseLeave = () => {
            gsap.to(projectThumbnail, {
                scale: 0,
                duration: 0.3,
                ease: "power2.out",
                overwrite: "auto",
            });
        };

        projectsContainer.addEventListener("mousemove", handleMouseMove);
        projectsContainer.addEventListener("mouseleave", handleMouseLeave);

        const projectListeners: Array<() => void> = [];
        /* 每行滚轮节流时间戳（触控板一次手势几十个事件，不节流连翻好几张） */
        const lastWheelAt = new Map<number, number>();

        projectElements.forEach((project, index) => {
            const handleMouseEnter = () => {
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

            /* 29-4 rowWheel：行上滚轮 = 切图。这一下必须不吃列表滚动 ——
             * wheel 默认是 passive 的（调 preventDefault 会被浏览器忽略并打 warning），
             * 所以这里用原生 addEventListener({ passive: false }) + preventDefault。
             * 开关关着 / 单图行直接 return：滚轮照常滚列表，不拦。 */
            const handleRowWheel = (e: WheelEvent) => {
                if (!triggersRef.current.rowWheel) return;
                const n = countsRef.current[index] ?? 1;
                if (n <= 1) return;
                e.preventDefault();
                e.stopPropagation();
                const now = performance.now();
                if (now - (lastWheelAt.get(index) ?? 0) < WHEEL_MIN_INTERVAL_MS) return;
                lastWheelAt.set(index, now);
                const dir: 1 | -1 = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
                stepImage(index, dir);
            };

            project.addEventListener("mouseenter", handleMouseEnter);
            project.addEventListener("wheel", handleRowWheel, { passive: false });
            projectListeners.push(() => {
                project.removeEventListener("mouseenter", handleMouseEnter);
                project.removeEventListener("wheel", handleRowWheel);
            });
        });

        return () => {
            projectsContainer.removeEventListener("mousemove", handleMouseMove);
            projectsContainer.removeEventListener("mouseleave", handleMouseLeave);
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
                    /* 多图：横向 strip，translateX(-i*100%) + CSS transition 切图 */
                    const cur = Math.min(imgIndexes[index] ?? 0, srcs.length - 1);
                    return (
                        <div className="hover-img-thumbnail" key={index}>
                            <div
                                className="hover-img-multi"
                                data-img-index={cur}
                                data-img-count={srcs.length}
                                style={{ transform: `translateX(${-cur * 100}%)` }}
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
