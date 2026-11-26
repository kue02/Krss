import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Toast, toast } from "@heroui/react";
import { ArrowUpCircle } from "lucide-react";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
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
  const openWithTab = useSettingsModalStore((state) => state.openWithTab);
  const toastKeyRef = useRef<string | null>(null);

  // 登录后进任何页面都检查一次；store 内部节流，切页面/重挂载不会重复出网。
  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (!result?.hasUpdate) return;
    // 从 store 现取而不是用闭包里的值：StrictMode 下这个 effect 会跑两次，
    // 读渲染时捕获的 announcedVersion 会让同一条提示弹两遍。
    const state = useUpdateCheckStore.getState();
    if (state.announcedVersion === result.latestVersion) return;
    state.markAnnounced(result.latestVersion);

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
          // 先标记详情弹窗打开，再切到「关于」页 —— AboutSettings 的弹窗读的就是
          // 这个状态，于是点一次提示就能直接看到发布说明，不用再点第二次。
          setDetailOpen(true);
          openWithTab("about");
        },
      },
      onClose: () => {
        toastKeyRef.current = null;
        useUpdateCheckStore.getState().setToastVisible(false);
      },
    });
    useUpdateCheckStore.getState().setToastVisible(true);
  }, [result, setDetailOpen, openWithTab, t]);

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
