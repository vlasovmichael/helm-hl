import { defineConfig } from "vite";
import { resolve } from "node:path";

// Дашборда — multi-page, без фреймворка, чистые ES-модули.
// root = web/ (исходники), сборка → src/modules/dashboard/dist (раздаётся Express'ом в проде).
// Дев: vite-сервер на :5173 проксирует API/WS на Express (:3010).
const webRoot = resolve(__dirname, "src/modules/dashboard/web");

// В деве app-WS коннектится напрямую к Express, минуя Vite (его HMR-сокет висит на root /).
// См. web/src/net/websocket.js → import.meta.env.DEV.
const API_TARGET = process.env.DASHBOARD_DEV_TARGET || "http://localhost:3010";

export default defineConfig({
  root: webRoot,
  publicDir: "static",
  base: "/",
  build: {
    outDir: resolve(__dirname, "src/modules/dashboard/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(webRoot, "index.html"),
        ledger: resolve(webRoot, "ledger.html"),
        statistics: resolve(webRoot, "statistics.html"),
        lab: resolve(webRoot, "lab.html"),
        login: resolve(webRoot, "login.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
