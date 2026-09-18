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
