import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@heroui/react";
import { cn } from "@/lib/utils";
import { createPluginBridge } from "./bridge";
import type {
  PluginBridgeEntry,
  PluginBridgeView,
} from "./bridge";

/**
 * 插件自带界面的沙箱容器（56-25）。
 *
 * 插件的 HTML/JS 由 `GET /api/plugins/:id/ui/*` 发（56-24），这里只做三件事：
 *   1. 用 `sandbox="allow-scripts"` 把页面装进 opaque origin —— **不给** `allow-same-origin`，
 *      于是插件脚本碰不到宿主的 DOM / localStorage / 登录态（`window.parent.document` 直接抛
 *      SecurityError），也不能读宿主的 cookie。`referrerPolicy="no-referrer"` 免得把宿主地址带出去。
 *   2. 载入完成（onLoad）发一条 `host:init`：协议版本、插件 id、权限、语言、主题变量、
 *      当前条目（只给身份）/当前视图。主题是现读的 CSS 变量，插件照这套值画就跟宿主同一个配色。
 *   3. 把宿主的「确认框」接上：沙箱里没有 UI 组件，`plugin:ui.confirm` 必须由宿主用 HeroUI
 *      Modal 画出来 —— 这里就是那个 Modal 的宿主。
 *
 * 协议细节与消息校验在 `./bridge.ts`；这里只管「窗口从哪来」「弹窗怎么画」。
 */
export type SandboxFrameProps = {
  pluginId: string;
  /** 插件包内的 HTML 入口（相对 `/api/plugins/:id/ui/`），默认 `index.html` */
  page?: string;
  /** iframe 的可访问名（也是给屏幕阅读器的一句话） */
  title: string;
  /**
   * 插件申请到的权限（后端 `Meta.Permissions`）。缺省 = 什么都没有：
   * 拿不到数据、读不到条目，只能画自己带的东西。
   */
  permissions?: readonly string[];
  /** 当前条目（可选）：只给身份，正文要插件自己按权限走 bridge 拿 */
  entry?: PluginBridgeEntry;
  /** 当前插件视图（可选） */
  view?: PluginBridgeView;
  /** 语言，缺省 `zh`（与 i18n 一致时由调用方传 `i18n.language`） */
  locale?: string;
  /** 插件请求切视图 / 打开条目时回调；不传 = 忽略这类请求 */
  onNavigate?: (target: { viewId?: string; entryId?: string }) => void;
  className?: string;
};

/**
 * 把插件包里的路径逐段转义。
 *
 * 整串 `encodeURIComponent` 会把 `/` 也吃掉（`a/b.html` → `a%2Fb.html`），后端按段匹配就找不到文件；
 * 一段一段转义既能挡住 `..`（变成 `..` 仍在段内，由后端做穿越校验）也不破坏目录结构。
 */
function encodePluginPath(entry: string): string {
  return entry
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function SandboxFrame({
  pluginId,
  page = "index.html",
  title,
  permissions,
  entry,
  view,
  locale = "zh",
  onNavigate,
  className,
}: SandboxFrameProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  /**
   * 权限 / 条目 / 视图都从 ref 读：调用方大多在渲染里现造数组与对象（`permissions={["data"]}`），
   * 直接进 `useMemo` 依赖会让 bridge 每帧重建、message 监听每帧重挂 —— 而 init 只在 load 时发一次，
   * 重建没有任何收益。真正需要重建的只有 pluginId / 语言 / 导航回调。
   */
  const permissionsRef = useRef(permissions);
  permissionsRef.current = permissions;
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const viewRef = useRef(view);
  viewRef.current = view;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  /** 待确认的请求：`resolve` 是插件那条 `plugin:ui.confirm` 的回执出口 */
  const [confirmRequest, setConfirmRequest] = useState<
    { title: string; body?: string } | null
  >(null);
  /** 当前待确认请求的出口。放 ref 里：卸载时也要能把它兑现（插件不该永远等回执） */
  const pendingConfirmRef = useRef<((ok: boolean) => void) | null>(null);

  const bridge = useMemo(
    () =>
      createPluginBridge({
        pluginId,
        permissions: permissionsRef.current,
        frameWindow: () => frameRef.current?.contentWindow ?? null,
        entry: entryRef.current,
        view: viewRef.current,
        locale,
        confirm: ({ title: heading, body }) =>
          new Promise<boolean>((resolve) => {
            pendingConfirmRef.current = resolve;
            setConfirmRequest({ title: heading, body });
          }),
        navigate: (target) => navigateRef.current?.(target),
      }),
    [pluginId, locale],
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => bridge.handleMessage(event);
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [bridge]);

  /** 卸载（切视图 / 关面板）时按「没确认」收尾还挂着的那个 Promise */
  useEffect(
    () => () => {
      pendingConfirmRef.current?.(false);
      pendingConfirmRef.current = null;
    },
    [],
  );

  const settleConfirm = (ok: boolean) => {
    pendingConfirmRef.current?.(ok);
    pendingConfirmRef.current = null;
    setConfirmRequest(null);
  };

  return (
    <>
      <iframe
        ref={frameRef}
        src={`/api/plugins/${encodeURIComponent(pluginId)}/ui/${encodePluginPath(page)}`}
        // 关键：只有 allow-scripts。加了 allow-same-origin 就等于把插件放进宿主源里，
        // 沙箱形同虚设（插件能直接读 localStorage 里的 token）。
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={cn("h-full w-full border-0", className)}
        title={title}
        // onLoad 之后 contentWindow 才稳定；此时发 init，插件脚本无论监听得多早都能收到
        // （早于 init 的 ready 由 bridge 忽略，不做握手依赖）
        onLoad={() => bridge.sendInit()}
        data-plugin-id={pluginId}
      />
      {confirmRequest && (
        <Modal>
          <Modal.Backdrop isOpen onOpenChange={(open) => !open && settleConfirm(false)}>
            <Modal.Container>
              <Modal.Dialog className="max-w-md">
                <Modal.CloseTrigger />
                <Modal.Header>
                  <Modal.Heading>{confirmRequest.title}</Modal.Heading>
                </Modal.Header>
                {confirmRequest.body ? (
                  <Modal.Body>
                    <div className="text-sm text-muted-foreground">
                      {confirmRequest.body}
                    </div>
                  </Modal.Body>
                ) : null}
                <Modal.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => settleConfirm(false)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onPress={() => settleConfirm(true)}
                  >
                    {t("actions.confirm")}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </>
  );
}
