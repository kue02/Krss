import { dismissToast, useToasts } from "@/stores/toast-store";

/** 全局提示条：底部居中，自动消失（配合 stores/toast-store 使用） */
export function Toaster() {
  const toasts = useToasts();

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className="nf-enter pointer-events-auto max-w-[80vw] truncate rounded-full border border-border/60 bg-overlay/90 px-3.5 py-1.5 text-xs font-medium text-foreground shadow-nf backdrop-blur-xl transition-colors duration-200 hover:bg-overlay"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
