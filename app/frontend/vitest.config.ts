import { defineConfig, mergeConfig } from "vitest/config";
import type { UserConfig } from "vite";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig as UserConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["e2e/**", "node_modules/**"],
      // jsdom 缺 Web Animations API（涟漪点击会用到），补在 setup 里，见该文件注释
      setupFiles: ["./src/test/setup-dom.ts"],
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.d.ts", "src/main.tsx"],
      },
    },
  }),
);
