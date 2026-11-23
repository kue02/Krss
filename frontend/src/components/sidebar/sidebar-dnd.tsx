import { createContext, useContext, type ReactNode } from "react";
import type { ContentType } from "@/types/api";

/**
 * 侧栏拖拽（Web 桌面）的共享上下文。
 *
 * 设计要点：
 * - 没有 Provider 时（例如单元测试单独渲染 FeedItem）`useSidebarDndOptional()` 返回 null，
 *   行组件据此**退化为不可拖**，不抛错、不改变既有右键/长按行为。
 * - 上下文只承载「谁在拖、落点是哪、行/容器要展开的事件」，真正的移动/排序与持久化
 *   全部收口在 Sidebar（数据都在那里）。行组件不碰数据与接口。
 */
export type DragKind = "feed" | "folder";

export interface DragEntity {
  kind: DragKind;
  id: string;
  type: ContentType;
  /** feed：所在文件夹；folder：父文件夹。undefined = 顶层 / 未分组 */
  containerId?: string;
}

export type DropPosition = "before" | "after" | "inside";

export interface DropTarget {
  /** 命中的那一行的类型与 id */
  kind: DragKind;
  id: string;
  position: DropPosition;
}

export interface DragRowProps {
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

export interface DragContainerProps {
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

export interface SidebarDndValue {
  /** 桌面才允许拖动；移动端靠长按菜单，不启用拖拽 */
  canDrag: boolean;
  dragging: DragEntity | null;
  dropTarget: DropTarget | null;
  /** 行级事件：entity 是这一行自身的实体，rowKind 是这一行的类型 */
  rowProps: (entity: DragEntity, rowKind: DragKind) => DragRowProps;
  /** 容器（空白 / 根区）事件 */
  containerProps: () => DragContainerProps;
}

const SidebarDndContext = createContext<SidebarDndValue | null>(null);

export function SidebarDndProvider({
  value,
  children,
}: {
  value: SidebarDndValue;
  children: ReactNode;
}) {
  return (
    <SidebarDndContext.Provider value={value}>
      {children}
    </SidebarDndContext.Provider>
  );
}

/** 必须在 Provider 内使用；FeedCategory 用在 Sidebar 树里，属于这种情况。 */
export function useSidebarDnd(): SidebarDndValue {
  const value = useContext(SidebarDndContext);
  if (!value) {
    throw new Error("useSidebarDnd must be used within SidebarDndProvider");
  }
  return value;
}

/** 容许没有 Provider（单元测试/独立渲染）时安全降级为 null。 */
export function useSidebarDndOptional(): SidebarDndValue | null {
  return useContext(SidebarDndContext);
}
