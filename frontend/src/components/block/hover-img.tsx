"use client";

/*
 * obsidianui hover-img（https://www.obsidianui.dev/docs/hover-img）的上游源码。
 * 骨架与 gsap 逻辑保持原样，下面是 krss 的 5 处扩展，逐处标注：
 *
 *  ① ProjectItem 增加 iconSrc（来源图标）/ images（一篇的多张图）
 *  ② 行首加来源图标（标题前）
 *  ③ 浮块内多图可左右切换（track + translateX），并显示 n/N 计数
 *  ④ 浮块从上游的「全程 pointer-events:none」改为「指针进入即冻结」——不冻结就点不到切换按钮；
 *     随之「从行移到浮块」会跨一段空隙，行此时已 mouseleave，故收起改为延迟 220ms（草图阶段实测出）
 *  ⑤ 指针在浮块内时不更新跟随坐标（配合 ④）
 *
 * 另有 1 处纯为编译：上游默认导入 React 但未使用，本项目 tsconfig 开了 noUnusedLocals，去掉默认导入。
 */

import { useRef, useEffect, useState } from "react";
import gsap from "gsap";
import "@/components/block/hover-img.css";

interface ProjectItem {
    title: string;
    label: string;
    imageSrc: string;
    /** ① krss 扩展：来源图标 URL；空则渲染占位块 */
    iconSrc?: string;
    /** ① krss 扩展：该条目的全部图片（多图时浮块内可切换）；缺省退化成 [imageSrc] */
    images?: string[];
}

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
}

/** ③ 取一篇的图；没有 images 就退化成单张 imageSrc */
function imagesOf(project: ProjectItem): string[] {
    if (project.images && project.images.length > 0) return project.images;
    return project.imageSrc ? [project.imageSrc] : [];
}

export function HoverImg({ projects = defaultProjects, className, isContained = false, compact = false }: HoverImgProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const thumbnailRef = useRef<HTMLDivElement>(null);
    const xToRef = useRef<gsap.QuickToFunc | null>(null);
    const yToRef = useRef<gsap.QuickToFunc | null>(null);

    /** ③ 指针当前所在的行，以及每行正在看第几张图 */
    const [activeIndex, setActiveIndex] = useState(0);
    const [currents, setCurrents] = useState<number[]>(() => projects.map(() => 0));

    /** ④ 指针是否停在浮块上（冻结）；⑤ 冻结时不再更新跟随坐标 */
    const frozenRef = useRef(false);
    const activeIndexRef = useRef(0);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

        const hide = () =>
            gsap.to(projectThumbnail, {
                scale: 0,
                duration: 0.3,
                ease: "power2.out",
                overwrite: "auto",
            });

        // ④ 延迟收起：给「指针从行移到浮块」跨过那段空隙留时间
        const cancelHide = () => {
            if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
        };
        const scheduleHide = () => {
            cancelHide();
            hideTimerRef.current = setTimeout(() => {
                if (!frozenRef.current) hide();
            }, 220);
        };

        // ④ 浮块本身保持 pointer-events:none（否则它居中在指针上、会把整行盖住点不动），
        //    改用「指针是否落在浮块矩形内」判断冻结：进矩形 → 停住跟随（按钮才点得到），出矩形 → 恢复
        const isOverThumbnail = (x: number, y: number) => {
            const r = projectThumbnail.getBoundingClientRect();
            return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        };

        const handleMouseMove = (e: MouseEvent) => {
            // ⑤ 指针在浮块里时不要跟着走，否则按钮会被「追着」点不到
            if (isOverThumbnail(e.clientX, e.clientY)) {
                cancelHide();
                frozenRef.current = true;
                return;
            }
            frozenRef.current = false;

            let x = e.clientX;
            let y = e.clientY;

            if (isContained && containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                x = e.clientX - rect.left;
                y = e.clientY - rect.top;
            }

            // ⑥ krss 扩展：浮块以自身中心跟随指针，指针靠近视口边缘时会被裁掉（实测第 1 行在顶部时
            //    浮块有一半在视口外、压住顶栏），这里把中心钳制在视口内并留出边距
            if (!isContained) {
                const halfW = projectThumbnail.offsetWidth / 2;
                const halfH = projectThumbnail.offsetHeight / 2;
                const margin = 16;
                if (halfW > 0 && halfH > 0) {
                    x = Math.min(Math.max(x, halfW + margin), window.innerWidth - halfW - margin);
                    y = Math.min(Math.max(y, halfH + margin), window.innerHeight - halfH - margin);
                }
            }

            xToRef.current?.(x);
            yToRef.current?.(y);
        };

        // ④ 上游这里是立即 hide()，改成延迟（判据见上）
        const handleMouseLeave = () => {
            if (!frozenRef.current) scheduleHide();
        };

        projectsContainer.addEventListener("mousemove", handleMouseMove);
        projectsContainer.addEventListener("mouseleave", handleMouseLeave);

        const projectListeners: Array<() => void> = [];

        projectElements.forEach((project, index) => {
            const handleMouseEnter = () => {
                cancelHide(); // 从浮块回到行上时不要被收起
                activeIndexRef.current = index;
                setActiveIndex(index);
                // ③ 换行时回到该篇的第一张
                setCurrents((prev) => {
                    if ((prev[index] ?? 0) === 0) return prev;
                    const next = [...prev];
                    next[index] = 0;
                    return next;
                });

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

            project.addEventListener("mouseenter", handleMouseEnter);
            projectListeners.push(() =>
                project.removeEventListener("mouseenter", handleMouseEnter)
            );
        });

        return () => {
            cancelHide();
            projectsContainer.removeEventListener("mousemove", handleMouseMove);
            projectsContainer.removeEventListener("mouseleave", handleMouseLeave);
            projectListeners.forEach((cleanup) => cleanup());
        };
    }, [projects, isContained]);

    /** ③ 切图：只作用于指针当前所在的那一行 */
    const step = (dir: number) => {
        const index = activeIndexRef.current;
        setCurrents((prev) => {
            const project = projects[index];
            if (!project) return prev;
            const total = imagesOf(project).length;
            if (total <= 1) return prev;
            const next = [...prev];
            next[index] = ((prev[index] ?? 0) + dir + total) % total;
            return next;
        });
    };

    const activeProject = projects[activeIndex];
    const activeImages = activeProject ? imagesOf(activeProject) : [];
    const activeCurrent = currents[activeIndex] ?? 0;

    return (
        <div className={`hover-img-container ${compact ? "hover-img-compact" : ""} ${className || ""}`} ref={containerRef}>
            <div className="hover-img-projects">
                {projects.map((project, index) => (
                    <div className="hover-img-project" key={index}>
                        {/* ② krss 扩展：行首来源图标 */}
                        <div className="hover-img-title-row">
                            {project.iconSrc ? (
                                <img className="hover-img-icon" src={project.iconSrc} alt="" loading="lazy" />
                            ) : (
                                <span className="hover-img-icon hover-img-icon-empty" aria-hidden="true" />
                            )}
                            <h2>{project.title}</h2>
                        </div>
                        <p>{project.label}</p>
                    </div>
                ))}
            </div>

            <div
                className="hover-img-thumbnail-wrapper"
                ref={thumbnailRef}
                style={isContained ? { position: "absolute" } : undefined}
            >
                {projects.map((project, index) => {
                    const imgs = imagesOf(project);
                    const shown = imgs.length > 0 ? imgs : [""];
                    const cur = currents[index] ?? 0;
                    const unit = 100 / shown.length;
                    return (
                        <div className="hover-img-thumbnail" key={index}>
                            {/* ③ 一行里的多张图横向排，整体平移切换 */}
                            <div
                                className="hover-img-thumbnail-track"
                                style={{
                                    width: `${shown.length * 100}%`,
                                    transform: `translateX(-${cur * unit}%)`,
                                }}
                            >
                                {shown.map((src, k) => (
                                    <img
                                        key={k}
                                        src={src}
                                        alt={project.title}
                                        style={{ width: `${unit}%` }}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                })}

                {/* ③ 多图时才给切换按钮与计数，只作用于当前行 */}
                {activeImages.length > 1 && (
                    <>
                        <button
                            type="button"
                            className="hover-img-nav prev"
                            aria-label="上一张"
                            onClick={(e) => {
                                e.stopPropagation();
                                step(-1);
                            }}
                        />
                        <button
                            type="button"
                            className="hover-img-nav next"
                            aria-label="下一张"
                            onClick={(e) => {
                                e.stopPropagation();
                                step(1);
                            }}
                        />
                        <span className="hover-img-counter">
                            {activeCurrent + 1} / {activeImages.length}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}

export default HoverImg;
