import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Toast, toast } from "@heroui/react";
import { ArrowUpCircle } from "lucide-react";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * 全局检查版本更新：登录后进任何页面都查一次，有更新在右下角给一条提示。
 *
 * 挂在已登录布局里 —— 检查接口在 JWT 组内，未登录调只会拿 401。
 * 网络请求、30 分钟节流与并发去重都在 `useUpdateCheckStore` 里，
 * 所以「进主页」和「打开关于页」共用同一份结果，不会两边各打一次 GitHub。
 *
 * 提示只在**有更新**时出现：已是最新、限流、网络失败都静默 ——
 * 右下角常驻一条红色失败条只会变成骚扰，而用户打开「关于」页能看到具体原因。
 */
export function UpdateChecker() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const check = useUpdateCheckStore((state) => state.check);
  const result = useUpdateCheckStore((state) => state.result);
  const setDetailOpen = useUpdateCheckStore((state) => state.setDetailOpen);
  const detailOpen = useUpdateCheckStore((state) => state.detailOpen);
  const toastKeyRef = useRef<string | null>(null);

  // 登录后进任何页面都检查一次；store 内部节流，切页面/重挂载不会重复出网。
  useEffect(() => {
    void check();
  }, [check]);

  const hideToast = useCallback(() => {
    if (!toastKeyRef.current) return;
    toast.close(toastKeyRef.current);
    toastKeyRef.current = null;
    useUpdateCheckStore.getState().setToastVisible(false);
  }, []);

  const showToast = useCallback(() => {
    if (!result?.hasUpdate) return;
    // 已经在屏幕上就不再弹一条（effect 重跑、StrictMode 双调用都会走到这里）。
    if (toastKeyRef.current) return;

    toastKeyRef.current = toast(t("update.available"), {
      description: t("update.banner_desc", { version: result.latestVersion }),
      // 变体用 default 而不是 warning：warning 会把标题压成 --warning-soft-foreground
      // （亮色主题下 14px 只有 3.4:1，达不到 AA），标题可读优先，颜色语义交给指示图标。
      indicator: (
        <ArrowUpCircle
          className="size-4 text-warning-soft-foreground"
          strokeWidth={2}
        />
      ),
      variant: "default",
      // 0 = 不自动消失。提示自己消失的话，用户回来就再也找不到这个入口了。
      timeout: 0,
      actionProps: {
        size: "sm",
        // 同关于页：primary 用的是 --accent（默认 #000000），暗色下黑底黑字
        className:
          "border border-foreground bg-foreground text-background shadow-none hover:bg-foreground/90",
        children: t("update.view_details"),
        onPress: () => {
          // 只开详情弹窗，不进设置：「看更新内容」是读文档，不该顺带把用户
          // 拽进设置页；弹窗挂在 App 已登录层，这里直接可见。
          setDetailOpen(true);
        },
      },
      onClose: () => {
        toastKeyRef.current = null;
        useUpdateCheckStore.getState().setToastVisible(false);
      },
    });
    useUpdateCheckStore.getState().setToastVisible(true);
  }, [result, setDetailOpen, t]);

  useEffect(() => {
    if (!result?.hasUpdate) return;
    // 从 store 现取而不是用闭包里的值：StrictMode 下这个 effect 会跑两次，
    // 读渲染时捕获的 announcedVersion 会让同一条提示弹两遍。
    const state = useUpdateCheckStore.getState();
    if (state.announcedVersion !== result.latestVersion) {
      state.markAnnounced(result.latestVersion);
    }
    showToast();
  }, [result, showToast]);

  // 详情弹窗开着时把提示收起来：toast 的层级（100001）压在弹窗（100000）之上，
  // 手机屏又窄，常驻提示会盖住弹窗底部那排按钮。弹窗里本来就是同一份更新说明，
  // 关掉弹窗再把提示放回来。
  useEffect(() => {
    if (detailOpen) {
      hideToast();
      return;
    }
    showToast();
  }, [detailOpen, hideToast, showToast]);

  // 谁弹谁收：登出、切账号或整个布局卸载时，把队列里这条常驻提示清掉。
  // ToastProvider 卸载不会清队列（只摘监听），留着的话下一位登录者会看到
  // 上一位账号的提示原样复活。
  useEffect(() => {
    return () => {
      if (toastKeyRef.current) {
        toast.close(toastKeyRef.current);
        toastKeyRef.current = null;
      }
      const state = useUpdateCheckStore.getState();
      state.setToastVisible(false);
      state.reset();
    };
  }, []);

  return (
    <Toast.Provider
      placement="bottom end"
      width={380}
      // 自己渲染整条提示，只为把关闭按钮的 aria-label 换成本地化文案：
      // HeroUI 的 CloseButton 把 `aria-label: "Close"` 写死了（close-button.js:21），
      // 而 react-aria 明明已经带了 zh-CN 的「关闭」翻译，只是没被用上。
      // 结构与 HeroUI 默认 children 一致（toast.js getDefaultChildren）。
      children={(renderProps) => {
        const content = renderProps.toast.content;
        const actionProps = content?.actionProps;
        const actionButton =
          actionProps?.children != null ? (
            <Toast.ActionButton {...actionProps} />
          ) : null;
        return (
          <Toast toast={renderProps.toast} variant={content?.variant}>
            <Toast.Indicator variant={content?.variant}>
              {content?.indicator}
            </Toast.Indicator>
            <Toast.Content>
              {content?.title ? (
                <Toast.Title>{content.title}</Toast.Title>
              ) : null}
              {content?.description ? (
                <Toast.Description>{content.description}</Toast.Description>
              ) : null}
              {isMobile ? actionButton : null}
            </Toast.Content>
            {isMobile ? null : actionButton}
            <Toast.CloseButton aria-label={t("update.dismiss_toast")} />
          </Toast>
        );
      }}
      // 移动端底部有 3.5rem 的 tab bar，默认的 bottom-4 会被压在它下面。
      // region 是 fixed 定位，内联 style 能盖掉 .toast-region--bottom-end 的 bottom-4。
      style={
        isMobile
          ? {
              bottom:
                "calc(3.5rem + env(safe-area-inset-bottom, 0px) + 0.75rem)",
            }
          : undefined
      }
    />
  );
}
