import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

// 后端地址：并行开工时（另一条线占着 :8080）用 KRSS_DEV_BACKEND 指向自己的后端，例如
//   KRSS_DEV_BACKEND=http://localhost:8082 bun run dev
const backendOrigin = process.env.KRSS_DEV_BACKEND ?? "http://localhost:8080";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "logo.svg",
        "favicon.ico",
        "apple-touch-icon-180x180.png",
      ],
      manifest: {
        name: "Krss - RSS Reader",
        short_name: "Krss",
        description: "A modern RSS reader",
        theme_color: "#E3E1DE",
        background_color: "#E3E1DE",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "pwa-64x64.png",
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: [
          "index.html",
          "manifest.webmanifest",
          "assets/*.js",
          "assets/*.css",
          "*.png",
          "*.svg",
        ],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api/],
        cleanupOutdatedCaches: true,
        // Workaround for Chrome 143+ ServiceWorkerAutoPreload regression (chromium #466790291)
        // Opt out of auto-preload by routing all requests through fetch-event
        importScripts: ["sw-preload-fix.js"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "gstatic-fonts-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /\/icons\/[^/]+$/,
            handler: "CacheFirst",
            options: {
              cacheName: "feed-icons-cache",
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /\/api\/proxy\/image\/.+/,
            handler: "CacheFirst",
            options: {
              cacheName: "proxied-images-cache",
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    // 局域网 dev 访问：0.0.0.0 监听 + 放行任意 Host（仅开发服务器，生产走构建产物不受影响）
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": backendOrigin,
      // MCP 出向端点在**后端**同源（生产就是同一个 origin）；dev 下不代理的话，
      // 界面里那份「客户端配置示例」给出的 http://localhost:5174/mcp 是个打不通的地址。
      "/mcp": backendOrigin,
      // 订阅图标由后端提供；不代理的话 dev 下会落到 SPA 兜底（返回 HTML），
      // <img> 加载失败就退回默认图标（表现为「明明有图标却不显示」）
      "/icons": backendOrigin,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/app-[hash].js",
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("/react/") || id.includes("/react-dom/"))
              return "react-vendor";
            if (
              id.includes("@tanstack/react-query") ||
              id.includes("@tanstack/react-virtual")
            )
              return "query-vendor";
            if (id.includes("@radix-ui/")) return "radix-vendor";
            if (id.includes("/motion/") || id.includes("/framer-motion/"))
              return "motion-vendor";
            if (id.includes("/i18next/") || id.includes("/react-i18next/"))
              return "i18n-vendor";
            if (
              id.includes("/clsx/") ||
              id.includes("/tailwind-merge/") ||
              id.includes("/zustand/") ||
              id.includes("/wouter/")
            )
              return "utils-vendor";
            if (
              id.includes("/unified/") ||
              id.includes("/rehype-parse/") ||
              id.includes("/rehype-sanitize/") ||
              id.includes("/rehype-stringify/") ||
              id.includes("/hast-util-to-jsx-runtime/")
            )
              return "html-parser-vendor";
            if (id.includes("@virtuoso.dev/masonry")) return "masonry-vendor";
            if (id.includes("/embla-carousel")) return "carousel-vendor";
          }
        },
      },
    },
  },
});
