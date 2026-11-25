import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", "coverage"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v7 默认把 React Compiler 诊断作为 error。
      // 本项目未启用 React Compiler，这些诊断先降为 warning，避免阻断 CI。
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // Vite HMR 约束：工具文件与组件同文件导出属既有风格，降为 warning。
      "react-refresh/only-export-components": "warn",
      // 允许以 _ 前缀显式标记「故意未使用」的参数/变量
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // 测试里的 mock 生成器可以在未 yield 前直接抛错，require-yield 不适用
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "require-yield": "off",
    },
  },
  {
    files: ["src/components/entry-list/EntryList.tsx"],
    rules: {
      "react-hooks/incompatible-library": "off",
    },
  },
]);
