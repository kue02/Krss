/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 从 package.json 注入 */
declare const __APP_VERSION__: string;

interface Window {
  __KRSS_BOOT_READY__?: boolean;
}

declare module "virtual:pwa-register/react" {
  import type { Dispatch, SetStateAction } from "react";
  import type { RegisterSWOptions } from "vite-plugin-pwa/types";

  export function useRegisterSW(options?: RegisterSWOptions): {
    needRefresh: [boolean, Dispatch<SetStateAction<boolean>>];
    offlineReady: [boolean, Dispatch<SetStateAction<boolean>>];
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  };
}
