"use client";

/*
 * obsidianui hover-img 原件（https://www.obsidianui.dev/docs/hover-img），
 * 机制（gsap.quickTo 跟随、yPercent 逐行切换、scale 进出场）与文件骨架一字未改。
 *
 * 对上游只有两处扩展，均在此标注：
 *   A. `ProjectItem` 增加可选 `iconSrc`（条目来源图标）
 *   B. 标题前渲染该图标，并用 `<span class="hover-img-title">` 包住标题文字（便于长标题截断）
 * 另有一处纯为通过本项目编译：去掉上游未使用的 `import React` 默认导入
 * （本项目 tsconfig 开了 noUnusedLocals）。外观尺寸一律由使用方的 CSS 调，不在这里改。
 */

import { useRef, useEffect } from "react";
import gsap from "gsap";
import "@/components/block/hover-img.css";

interface ProjectItem {
    title: string;
    label: string;
    imageSrc: string;
    /* krss: 条目来源图标（唯一对上游的扩展，见文末说明） */
    iconSrc?: string;
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

export function HoverImg({ projects = defaultProjects, className, isContained = false, compact = false }: HoverImgProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const thumbnailRef = useRef<HTMLDivElement>(null);
    const xToRef = useRef<gsap.QuickToFunc | null>(null);
    const yToRef = useRef<gsap.QuickToFunc | null>(null);

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

        projectElements.forEach((project, index) => {
            const handleMouseEnter = () => {
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
            projectsContainer.removeEventListener("mousemove", handleMouseMove);
            projectsContainer.removeEventListener("mouseleave", handleMouseLeave);
            projectListeners.forEach((cleanup) => cleanup());
        };
    }, [projects, isContained]);

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
                style={isContained ? { position: "absolute" } : undefined}
            >
                {projects.map((project, index) => (
                    <div className="hover-img-thumbnail" key={index}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={project.imageSrc} alt={project.title} />
                    </div>
                ))}
            </div>
        </div>
    );
}

export default HoverImg;
