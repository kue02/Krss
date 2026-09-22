/**
 * Vitest 的 jsdom 补丁层。
 *
 * jsdom 没有实现 Web Animations API，而卡片/侧栏的涟漪（m3-ripple）在点击时会调
 * `element.animate(...)`，并在下一次点击时调 `.cancel()`。缺这一层的话，任何点进卡片或
 * 侧栏按钮的测试都会抛 unhandled error —— 测试用例本身全绿，但 vitest 以退出码 1 收场
 * （`Tests 577 passed / Errors 2`），等于把质量门做废了。
 *
 * 这里只补最小可用形状（animate + cancel/finish），不做动画模拟：测试断言的是行为，
 * 不是动画帧。
 */
if (typeof Element !== "undefined" && !Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    return {
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      commitStyles: () => {},
      persist: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      finished: Promise.resolve(),
      currentTime: 0,
      playState: "finished",
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
  };
}

/**
 * 内存版 localStorage。
 *
 * 本机 Node 26 下 jsdom 的 localStorage 是 `undefined`（不是抛异常，是压根没这个对象），
 * 于是「设置落盘」这类用例全挂在 `localStorage.removeItem` 上 —— 21 批之前的 3 例既有失败
 * （useUISettings.unread-badge ×2、AdvancedSettings ×1）就是这个原因，与业务代码无关。
 *
 * 这里补一个最小可用的内存实现：测试断言的是「写了什么、能不能读回来」，
 * 不需要真持久化；生产代码走的仍是浏览器真实 localStorage（见 lib/settings-storage.ts）。
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * 最小可用的 `ResizeObserver`。
 *
 * jsdom 没有它，而 HeroUI 的 `ScrollShadow`（内部 `useScrollShadow`）在挂载时**直接 new**，
 * 不判存在性 —— 缺这一层时组件在 effect 里抛 `ReferenceError: ResizeObserver is not defined`，
 * **整块子树渲染不出来**（第十九批实测：自动刷新历史那条用例全挂在这上面，
 * 而报错栈指向 node_modules，看着像组件库的问题）。
 *
 * 这里只做到「构造成功、observe/unobserve 不抛」：测试断言的是结构与行为，不是尺寸驱动的
 * 视觉（渐隐/跑马灯距离这些必须在真机量）。本项目自己的 `MarqueeText` 另有 `typeof` 守卫，
 * 不依赖这个补丁。
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: NoopResizeObserver,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "ResizeObserver", {
      value: NoopResizeObserver,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * jsdom 没有 `CSS` 命名空间，而 react-aria 在**打开下拉/弹层**时会调 `CSS.escape(...)`
 *（`react-aria/dist/private/selection/utils.mjs` 的 `getItemElement` —— 用来按 `data-key` 找项）。
 * 缺了它，任何「点开 HeroUI Select 看选项」的测试都会以
 * `TypeError: Cannot read properties of undefined (reading 'escape')` 收场，
 * 而那其实是**环境缺口**、不是组件 bug（真机浏览器里 `CSS` 一直在）。
 *
 * 这里只补 `escape` 这一个方法：测试断言的是「选项在不在、是不是禁用」，不需要真转义。
 */
if (typeof globalThis.CSS === "undefined") {
  Object.defineProperty(globalThis, "CSS", {
    value: { escape: (value: string) => value },
    configurable: true,
    writable: true,
  });
}

/**
 * jsdom 没有 `ResizeObserver`，而 HeroUI 的 `ScrollShadow`（`useScrollShadow`）
 * 挂载即 `new ResizeObserver(...)` —— 任何渲染只读 JSON 区（MCPJsonView）的测试
 * 都会以 `ReferenceError` 收场，而那是**环境缺口**、不是组件 bug
 * （真机浏览器里 ResizeObserver 一直在；阴影方向测不了，但内容断言不受影响）。
 *
 * 这里补一个空转实现：observe/unobserve/disconnect 都收下不做事。
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: NoopResizeObserver,
    configurable: true,
    writable: true,
  });
}
