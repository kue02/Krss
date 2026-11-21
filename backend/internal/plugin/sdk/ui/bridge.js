/**
 * Krss 插件页面 bridge（SDK 侧，56-26）。
 *
 * 插件页面跑在 `sandbox="allow-scripts"` 的 iframe 里：origin 是 opaque，拿不到宿主的
 * DOM / cookie / localStorage，也不能 fetch 宿主接口（宿主 CSP 的 connect-src 'none'）。
 * 两侧唯一的通道是 postMessage —— 这个文件是**插件那一半**（宿主侧见
 * `frontend/src/plugins/bridge.ts`）。不引任何依赖、不给插件塞构建链：`<script src="./bridge.js">`
 * 之后直接用 `window.krss`。
 *
 * 协议（与宿主 bridge v1 一一对应）：
 *   插件 → 宿主  plugin:ready
 *               plugin:data.get|set|list|remove   {id, collection, key?, value?, prefix?}
 *               plugin:entries.get                {id, entryId}
 *               plugin:ui.toast                   {message}
 *               plugin:ui.confirm                 {id, title, body}
 *               plugin:navigate                   {viewId|entryId}
 *   宿主 → 插件  host:init                         {version, pluginId, permissions, locale, theme, entry?, view?}
 *               host:data.result                  {id, value?, error?}
 *               host:entries.result               {id, entry?, error?}
 *               host:confirm.result               {id, confirmed, error?}
 *               host:export.result                {id, error?}
 *               host:event                        {…}（selection 等主动事件，v1 尚未发出）
 *
 * 三条硬规矩：
 *   1. **只发 window.parent** —— 不往 top、不广播：插件数据只递给装它的那个窗口。
 *   2. **只收 host:* 且来自 window.parent** —— 别的窗口发来的 host:* 是冒名顶替宿主。
 *   3. **每条请求带自增 id + 10s 超时** —— 宿主卡住时插件能收尾（reject），不是永远转圈。
 */
(function () {
  "use strict";

  /** 协议版本（与宿主 BRIDGE_VERSION 对齐；插件可据此提示「SDK 太旧」） */
  var VERSION = 1;

  /** 单条请求超时：与宿主侧 BRIDGE_TIMEOUT_MS 同口径，两边同时兜底。 */
  var TIMEOUT_MS = 10000;

  /**
   * 目标 origin。沙箱 iframe 的 origin 是 opaque（宿主侧读到的 event.origin 恒为 "null"），
   * 给不出具体值，只能 "*"；安全性由「只发 window.parent」+ 宿主只认自己的 contentWindow 保证。
   */
  var TARGET_ORIGIN = "*";

  var seq = 0;
  /** id -> {resolve, reject, timer}（只在这条请求还没回执时存在） */
  var pending = Object.create(null);
  var initPayload = null;
  var initHandlers = [];
  var eventHandlers = [];

  /** 往宿主发一条消息（唯一出口：所有消息都经过这里，方便审计） */
  function post(type, payload) {
    window.parent.postMessage({ type: type, payload: payload || {} }, TARGET_ORIGIN);
  }

  function nextID() {
    seq += 1;
    return "r" + seq;
  }

  /**
   * 发一条要回执的请求：`id` 放进 payload（宿主 `requestIdOf` 先读 payload.id），
   * 超时后从 pending 里摘掉并 reject —— 迟到的回执不会二次结算。
   */
  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextID();
      var body = { id: id };
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
      }
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error("bridge 超时：宿主 10 秒没有回执（" + type + "）"));
      }, TIMEOUT_MS);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      post(type, body);
    });
  }

  /** 结算一条回执；不认识的 id（超时后才回来的）直接丢。 */
  function settle(type, payload) {
    var id = payload.id;
    if (!id || !pending[id]) return;
    var waiter = pending[id];
    delete pending[id];
    clearTimeout(waiter.timer);
    if (payload.error) {
      waiter.reject(new Error(String(payload.error)));
      return;
    }
    if (type === "host:confirm.result") {
      waiter.resolve(payload.confirmed === true);
      return;
    }
    if (type === "host:entries.result") {
      waiter.resolve(payload.entry);
      return;
    }
    waiter.resolve(payload.value);
  }

  function each(list, payload) {
    for (var i = 0; i < list.length; i += 1) {
      // 插件自己的回调抛错不该带走别的监听者（也不该把 bridge 弄挂）
      try {
        list[i](payload);
      } catch (err) {
        if (window.console && window.console.error) window.console.error(err);
      }
    }
  }

  window.addEventListener("message", function (event) {
    // ① 只认宿主：别的窗口（含同文档脚本）发 host:* 是冒名顶替，整条丢掉
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data.type !== "string") return;
    // ② 只认 host: 前缀：插件自己发出去的 plugin:* 绝不会被当成回执
    if (data.type.indexOf("host:") !== 0) return;
    var payload = data.payload || {};

    if (data.type === "host:init") {
      initPayload = payload;
      each(initHandlers, payload);
      return;
    }
    if (data.type === "host:event") {
      each(eventHandlers, payload);
      return;
    }
    settle(data.type, payload);
  });

  function dataRequest(action, payload) {
    return request("plugin:data." + action, payload);
  }

  function requireText(name, value) {
    var text = value === undefined || value === null ? "" : String(value);
    if (!text) throw new Error(name + " 不能为空");
    return text;
  }

  /**
   * 插件的全部能力面。
   *
   * 数据值一律是**不透明字符串**（宿主一个字节都不改）：`set` 收对象时由这里 JSON 序列化，
   * `get` 原样返回字符串，要不要 parse 由插件自己决定。
   */
  window.krss = {
    version: VERSION,

    /** 通知宿主「我起来了」（宿主不依赖它，但排障时能看到握手） */
    ready: function () {
      post("plugin:ready", { version: VERSION });
    },

    /** 收 host:init；init 已经到过就立刻回调（页面晚挂脚本也不会错过） */
    onInit: function (fn) {
      if (typeof fn !== "function") return;
      if (initPayload) {
        fn(initPayload);
        return;
      }
      initHandlers.push(fn);
    },

    /** 收宿主主动事件（selection 等）；v1 宿主还没发，先留接口 */
    onEvent: function (fn) {
      if (typeof fn === "function") eventHandlers.push(fn);
    },

    data: {
      get: function (collection, key) {
        return dataRequest("get", {
          collection: requireText("collection", collection),
          key: requireText("key", key)
        });
      },
      set: function (collection, key, value) {
        return dataRequest("set", {
          collection: requireText("collection", collection),
          key: requireText("key", key),
          // 宿主只收字符串：对象/数组在这里序列化，数字/布尔也转成字符串
          value: typeof value === "string" ? value : JSON.stringify(value)
        });
      },
      list: function (collection, prefix) {
        return dataRequest("list", {
          collection: requireText("collection", collection),
          prefix: prefix ? String(prefix) : ""
        });
      },
      remove: function (collection, key) {
        return dataRequest("remove", {
          collection: requireText("collection", collection),
          key: requireText("key", key)
        });
      }
    },

    entries: {
      /** 读一条条目（正文要不要得到看插件声明的 entries:read / entries:full） */
      get: function (id) {
        return request("plugin:entries.get", { entryId: requireText("entryId", id) });
      }
    },

    /** 宿主提示条（不等回执） */
    toast: function (message) {
      post("plugin:ui.toast", { message: message === undefined ? "" : String(message) });
    },

    /** 宿主用 HeroUI Modal 画的确认框；没接确认能力的宿主一律回 false */
    confirm: function (title, body) {
      return request("plugin:ui.confirm", {
        title: title === undefined ? "" : String(title),
        body: body === undefined ? "" : String(body)
      });
    },

    /** 只允许「切视图 / 打开条目」两种，其余键丢掉（沙箱不能揣任意 URL 进宿主路由） */
    navigate: function (target) {
      var options = target || {};
      var payload = {};
      if (options.viewId) payload.viewId = String(options.viewId);
      if (options.entryId) payload.entryId = String(options.entryId);
      post("plugin:navigate", payload);
    },

    /** host:init 拷来的主题 CSS 变量（未 init 时给空对象，调用方 `??` 兜底） */
    theme: function () {
      return (initPayload && initPayload.theme) || {};
    }
  };
})();
