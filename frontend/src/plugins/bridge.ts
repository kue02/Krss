/**
 * 沙箱插件的 bridge v1（宿主侧，56-25）。
 *
 * 沙箱 iframe 是 `sandbox="allow-scripts"`、**不给** `allow-same-origin`：它的 origin 是 opaque，
 * 拿不到宿主的 DOM / localStorage / cookie，宿主也认不出它的 origin（`event.origin` 恒为 "null"）。
 * 两侧唯一的通道就是 `postMessage` —— 这个文件是宿主那一半：谁能发、发来什么、能不能办、答什么。
 *
 * 协议（`docs/dev/插件模块.md` / 计划 §3.4）：
 *   host→plugin  host:init            {version, pluginId, permissions, locale, theme, entry?, view?}
 *   host→plugin  host:data.result     {id, value?, error?}
 *   host→plugin  host:entries.result  {id, entry?, error?}
 *   host→plugin  host:confirm.result  {id, confirmed}
 *   host→plugin  host:export.result   {id, error}（v1 不做导出）
 *   plugin→host  plugin:ready | plugin:data.get|set|list|remove | plugin:entries.get
 *                | plugin:ui.toast | plugin:ui.confirm | plugin:navigate | plugin:export
 *
 * 三条硬规矩：
 *   1. **只认自己那个 iframe**：`event.source === frameWindow`，否则整条丢掉（连回执都不发 ——
 *      回执本身就是「这个窗口存在」的信息泄漏）。
 *   2. **只认 plugin: 前缀**：宿主自己的 host:* 消息从小窗里冒出来一律当冒名顶替。
 *   3. **能力只走 permissions**：数据要 `data`、读条目要 `entries:read`（正文另要 `entries:full`）、
 *      导出要 `export`；没有就回 error，**不去打接口**。
 */

import { getEntry } from "@/api";
import { showToast } from "@/stores/toast-store";
import type { Entry } from "@/types/api";
import {
  deletePluginData,
  fetchPluginData,
  listPluginData,
  putPluginData,
} from "./api";

/** 协议版本：宿主与插件对齐用，插件可以据此提示「你的 SDK 太旧」 */
export const BRIDGE_VERSION = 1;

/**
 * 请求超时。插件发来一条请求、宿主这边 10 秒还没办完（后端卡住 / 网络挂住），
 * 就回 `{error:"timeout"}`：沙箱那边至少能收尾、能给用户一句失败，而不是永远转圈。
 */
export const BRIDGE_TIMEOUT_MS = 10_000;

/**
 * 抄给插件的主题变量。
 *
 * 只抄「语义色 + 圆角」这一小撮：插件要的是「跟宿主同一个配色」，不是宿主的整套主题系统。
 * 名字取 HeroUI 的真变量（`--background` / `--surface` / `--accent` …，见 `index.css` 的
 * `@theme` 段），另外带 `--card` —— 计划里写的就是这个名字，项目里它是 `--surface` 的别名
 * （`--color-card: var(--surface)`）；取不到就不放进结果，插件那边 `?? fallback` 兜底。
 */
export const THEME_VAR_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--surface",
  "--surface-foreground",
  "--overlay",
  "--overlay-foreground",
  "--accent",
  "--accent-foreground",
  "--muted",
  "--border",
  "--danger",
  "--radius",
] as const;

/**
 * 从 `<html>` 上读主题变量。
 *
 * 用 `getComputedStyle` 而不是 `element.style`：主题是 CSS 层叠出来的（`data-theme` ×
 * `@theme` 映射 × 用户自定义主题色），内联 style 上只有「用户改过的那几项」。再退一层读内联：
 * jsdom 不跑样式表，测试里 setProperty 的内联值要能读到（生产上这两条顺序不影响结果）。
 */
export function getThemeVars(
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): Record<string, string> {
  const theme: Record<string, string> = {};
  if (!root) return theme;
  const computed =
    typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  for (const name of THEME_VAR_NAMES) {
    const value = (
      computed?.getPropertyValue(name) ||
      root.style.getPropertyValue(name) ||
      ""
    ).trim();
    if (value) theme[name] = value;
  }
  return theme;
}

/** 插件视图（自定义视图在 host:init 里告诉插件「你现在渲染的是哪一个」） */
export type PluginBridgeView = { id: string; title?: string };

/**
 * 宿主给插件的「当前条目」——只给身份。
 *
 * 正文**不在这里**：正文要插件自己 `plugin:entries.get` 并按权限拿，否则「打开一个插件视图」
 * 这个动作本身就成了绕过权限的全文通道。
 */
export type PluginBridgeEntry = { id: string; title?: string; url?: string };

/** 插件发来的一条消息（只描述我们读得到的部分） */
type IncomingMessage = {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
};

export type PluginBridgeOptions = {
  pluginId: string;
  /** 插件在 manifest 里申请的权限（后端 `Meta.Permissions`）；缺省 = 什么都没有 */
  permissions?: readonly string[];
  /**
   * 取「沙箱 iframe 的 contentWindow」。
   *
   * 传函数而不是窗口本身：React 里 iframe 挂载完才有 contentWindow，而 bridge 是在挂载前
   * `useMemo` 出来的；每次真正要发消息时现取，重挂载（换 entry / 换视图）也自然跟上。
   */
  frameWindow: () => Window | null | undefined;
  /** 当前条目身份（可选） */
  entry?: PluginBridgeEntry;
  /** 当前插件视图（可选） */
  view?: PluginBridgeView;
  /** 语言，缺省 zh（i18n 的 language） */
  locale?: string;
  /** 提示条；缺省用宿主既有的 toast store */
  toast?: (message: string) => void;
  /**
   * 确认框（宿主必须用 HeroUI Modal 画，沙箱里没有 UI 组件）。返回用户是否点了确认；
   * 不传 = 没有确认能力，一律回 false。
   */
  confirm?: (request: { title: string; body?: string }) => Promise<boolean>;
  /** 切视图 / 打开条目；不传 = 忽略（沙箱不能自己改宿主路由） */
  navigate?: (target: { viewId?: string; entryId?: string }) => void;
  /** 请求超时（毫秒），缺省 10s */
  timeoutMs?: number;
};

export type PluginBridge = {
  /** iframe onLoad 之后调一次：发 host:init */
  sendInit: () => void;
  /** `window.addEventListener("message", bridge.handleMessage)` */
  handleMessage: (event: MessageEvent) => void;
  /** 往沙箱发一条消息（目前只有 init 用得到，导出留给宿主主动事件 host:event） */
  post: (type: string, payload: Record<string, unknown>) => void;
};

/** 插件请求的 id：协议表把它放在 payload 里，顶层也认（两种写法都见过，别让插件白等） */
function requestIdOf(data: IncomingMessage): string {
  const fromPayload = data.payload?.id;
  if (typeof fromPayload === "string") return fromPayload;
  if (typeof data.id === "string") return data.id;
  return "";
}

function isPluginMessage(data: unknown): data is IncomingMessage {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("plugin:");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 让「办事」与「超时」赛跑，只留一个结果。
 *
 * `Promise.race` 本身不清理输掉那条路的定时器 —— 一次请求就是一个并不必要的 10s 定时器，
 * 插件多问几次就会攒一堆；这里显式 clearTimeout。
 */
async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      task.then((value) => ({ ok: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 建一个宿主侧 bridge。
 *
 * 纯函数 + 闭包，不碰 React 状态：SandboxFrame 只负责把 `contentWindow`、确认框、路由
 * 这三件「宿主才有」的东西接进来，协议本身在 jsdom 里就能整条测（见 `bridge.test.ts`）。
 */
export function createPluginBridge(options: PluginBridgeOptions): PluginBridge {
  const {
    pluginId,
    permissions = [],
    frameWindow,
    entry,
    view,
    locale = "zh",
    toast = showToast,
    confirm,
    navigate,
    timeoutMs = BRIDGE_TIMEOUT_MS,
  } = options;

  const granted = new Set(permissions);
  const can = (permission: string) => granted.has(permission);

  function post(type: string, payload: Record<string, unknown>): void {
    const target = frameWindow();
    // 沙箱 origin 是 opaque，没法指定具体 origin；发给「这一个是哪个窗口」由我们持有，
    // 也不是广播（不是 window.parent / top），所以 "*" 在这里只意味着「不校验源」。
    target?.postMessage({ type, payload }, "*");
  }

  function sendInit(): void {
    post("host:init", {
      version: BRIDGE_VERSION,
      pluginId,
      permissions: [...granted],
      locale,
      theme: getThemeVars(),
      ...(entry ? { entry } : {}),
      ...(view ? { view } : {}),
    });
  }

  /** 数据类请求：先看权限，再打接口，最后统一回 host:data.result */
  async function handleData(
    action: "get" | "set" | "list" | "remove",
    payload: Record<string, unknown>,
    id: string,
  ): Promise<void> {
    const reply = (body: { value?: unknown; error?: string }) =>
      post("host:data.result", { id, ...body });

    if (!can("data")) {
      reply({ error: "permission denied: data" });
      return;
    }
    const collection = str(payload.collection);
    if (!collection) {
      reply({ error: "collection is required" });
      return;
    }
    const key = str(payload.key);

    try {
      const outcome = await withTimeout(
        (async () => {
          switch (action) {
            case "get":
              if (!key) throw new Error("key is required");
              return fetchPluginData(pluginId, collection, key);
            case "set":
              if (!key) throw new Error("key is required");
              // 值是不透明字符串：插件自己序列化，宿主一个字节都不改
              return putPluginData(pluginId, collection, key, str(payload.value));
            case "list":
              return listPluginData(pluginId, collection, {
                prefix: str(payload.prefix) || undefined,
              });
            case "remove":
              if (!key) throw new Error("key is required");
              await deletePluginData(pluginId, collection, key);
              return true;
          }
        })(),
        timeoutMs,
      );
      if (outcome.ok) reply({ value: outcome.value });
      else reply({ error: outcome.error });
    } catch (error) {
      reply({ error: errorMessage(error) });
    }
  }

  /**
   * 读一条条目。
   *
   * `entries:read` 给身份与元信息；正文（`content` / `readableContent`）只有 `entries:full`
   * 才给 —— 与后端 `service.Invoke` 的裁剪口径一致（那两个字段抹掉、别的字段不动），
   * 免得「同一个权限在两条路径上意思不同」。
   */
  async function handleEntriesGet(
    payload: Record<string, unknown>,
    id: string,
  ): Promise<void> {
    const reply = (body: { entry?: Partial<Entry>; error?: string }) =>
      post("host:entries.result", { id, ...body });

    if (!can("entries:read") && !can("entries:full")) {
      reply({ error: "permission denied: entries:read" });
      return;
    }
    const entryId = str(payload.entryId) || str(payload.id);
    if (!entryId) {
      reply({ error: "entryId is required" });
      return;
    }

    try {
      const outcome = await withTimeout(getEntry(entryId), timeoutMs);
      if (!outcome.ok) {
        reply({ error: outcome.error });
        return;
      }
      const found = outcome.value;
      if (!can("entries:full")) {
        const { content: _content, readableContent: _readable, ...rest } = found;
        reply({ entry: rest });
        return;
      }
      reply({ entry: found });
    } catch (error) {
      reply({ error: errorMessage(error) });
    }
  }

  async function handleConfirm(
    payload: Record<string, unknown>,
    id: string,
  ): Promise<void> {
    const title = str(payload.title);
    if (!confirm) {
      post("host:confirm.result", { id, confirmed: false });
      return;
    }
    try {
      const outcome = await withTimeout(
        confirm({ title, body: str(payload.body) || undefined }),
        timeoutMs,
      );
      post("host:confirm.result", {
        id,
        confirmed: outcome.ok ? outcome.value : false,
        ...(outcome.ok ? {} : { error: outcome.error }),
      });
    } catch (error) {
      post("host:confirm.result", { id, confirmed: false, error: errorMessage(error) });
    }
  }

  /**
   * 导航：只允许「切视图」与「打开条目」这两种，其余键一律丢掉。
   * 沙箱能改的只有宿主的选中态，不能借 navigate 揣一个任意 URL 进来。
   */
  function handleNavigate(payload: Record<string, unknown>): void {
    if (!navigate) return;
    const viewId = str(payload.viewId);
    const entryId = str(payload.entryId);
    if (viewId) navigate({ viewId });
    else if (entryId) navigate({ entryId });
  }

  function handleMessage(event: MessageEvent): void {
    const frame = frameWindow();
    // ① 只认自己那个 iframe：别的窗口（含宿主自己的 top）发来的 plugin:* 是想冒充插件
    if (!frame || event.source !== frame) return;
    // ② 只认 plugin: 前缀：host:* 从沙箱里冒出来 = 冒名顶替宿主
    if (!isPluginMessage(event.data)) return;

    const data = event.data;
    const payload = data.payload ?? {};
    const id = requestIdOf(data);

    switch (data.type) {
      case "plugin:ready":
        // 沙箱脚本起来了。宿主不依赖它（init 是 onLoad 就发的），留个位给将来的握手日志
        return;
      case "plugin:data.get":
        void handleData("get", payload, id);
        return;
      case "plugin:data.set":
        void handleData("set", payload, id);
        return;
      case "plugin:data.list":
        void handleData("list", payload, id);
        return;
      case "plugin:data.remove":
        void handleData("remove", payload, id);
        return;
      case "plugin:entries.get":
        void handleEntriesGet(payload, id);
        return;
      case "plugin:ui.toast":
        toast(str(payload.message));
        return;
      case "plugin:ui.confirm":
        void handleConfirm(payload, id);
        return;
      case "plugin:navigate":
        handleNavigate(payload);
        return;
      case "plugin:export":
        // v1 不做导出（下载由宿主接管是 56-31 的事）：有权限也回 error，别让插件以为写成功
        post("host:export.result", {
          id,
          error: can("export")
            ? "export is not available in bridge v1"
            : "permission denied: export",
        });
        return;
      default:
        // 认不出的 plugin:* 也要答一声：插件在等回执，别让它一直挂着
        post("host:data.result", { id, error: `unknown message: ${data.type}` });
    }
  }

  return { sendInit, handleMessage, post };
}
