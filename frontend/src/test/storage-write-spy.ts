/**
 * 测试用：数「往 localStorage 写了几次」。
 *
 * 为什么不能 `vi.spyOn(window.localStorage, "setItem")`：jsdom 的 `Storage` 是 Proxy 实现，
 * 给它赋一个方法名只会被当成**存了一条数据**（值被 String() 掉），spy 永远不被调用 ——
 * 单文件跑（走 setup-dom 的内存实现）能过、整仓跑就数出 0 次，属于最费时间的那种假绿。
 * 这里改成临时换掉 `window.localStorage` 这个对象本身，写入计数与真实写入同时发生。
 */
export interface StorageWriteSpy {
  /** 每个键被写了几次 */
  counts: Map<string, number>;
  countOf(key: string): number;
  restore(): void;
}

export function spyOnStorageWrites(): StorageWriteSpy {
  const real = window.localStorage;
  const counts = new Map<string, number>();

  const fake: Storage = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    getItem: (key: string) => real.getItem(key),
    key: (index: number) => real.key(index),
    removeItem: (key: string) => real.removeItem(key),
    setItem: (key: string, value: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      real.setItem(key, value);
    },
  };

  Object.defineProperty(window, "localStorage", {
    value: fake,
    configurable: true,
    writable: true,
  });

  return {
    counts,
    countOf: (key: string) => counts.get(key) ?? 0,
    restore: () => {
      Object.defineProperty(window, "localStorage", {
        value: real,
        configurable: true,
        writable: true,
      });
    },
  };
}
