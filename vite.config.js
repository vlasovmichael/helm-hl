import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Дашборда — multi-page, без фреймворка, чистые ES-модули.
// root = web/ (исходники), сборка → src/modules/dashboard/dist (раздаётся Express'ом в проде).
// Дев: vite-сервер на :5173 проксирует API/WS на Express (:3010).
const webRoot = resolve(__dirname, "src/modules/dashboard/web");

// В деве app-WS коннектится напрямую к Express, минуя Vite (его HMR-сокет висит на root /).
// См. web/src/net/websocket.js → import.meta.env.DEV.
const API_TARGET = process.env.DASHBOARD_DEV_TARGET || "http://localhost:3010";

/**
 * Общий <head> для всех страниц: подставляет web/head.html на место метки
 * `<!--#head-->`. Плагин, а не копипаст в десяти .html, — потому что копипаст
 * уже разошёлся (theme-color на половине страниц врал цветом из первой
 * версии палитры). Работает и в деве, и в сборке: transformIndexHtml с
 * `order: "pre"` отрабатывает до того, как Vite начнёт разбирать ссылки.
 */
function sharedHead() {
  const file = resolve(webRoot, "head.html");
  return {
    name: "helm-shared-head",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.includes("<!--#head-->")
          ? html.replace("<!--#head-->", readFileSync(file, "utf8"))
          : html;
      },
    },
  };
}

export default defineConfig({
  plugins: [sharedHead()],
  root: webRoot,
  publicDir: "static",
  base: "/",
  build: {
    outDir: resolve(__dirname, "src/modules/dashboard/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(webRoot, "index.html"),
        orderbook: resolve(webRoot, "orderbook.html"),
        orderbookSim: resolve(webRoot, "orderbook-sim.html"),
        journal: resolve(webRoot, "journal.html"),
        ledger: resolve(webRoot, "ledger.html"),
        statistics: resolve(webRoot, "statistics.html"),
        lab: resolve(webRoot, "lab.html"),
        oi: resolve(webRoot, "oi.html"),
        login: resolve(webRoot, "login.html"),
        // Стенд дизайна Trade Ticket на моках (биржи не касается). Живёт в
        // сборке намеренно: страницу удобно открыть и на задеплоенном дашборде,
        // чтобы посмотреть вёрстку с телефона.
        ticket: resolve(webRoot, "ticket.html"),
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
