import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Чистые пути страниц в деве. В проде /oi и /journal раздаёт server.js, а
 * дев-сервер знает только /oi.html — без переписывания ссылки между страницами
 * в деве ведут в пустоту.
 */
function cleanPagePaths() {
  return {
    name: "helm-clean-page-paths",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = req.url.split("?");
        const name = path.slice(1);
        if (/^[a-z-]+$/.test(name) && existsSync(resolve(webRoot, `${name}.html`))) {
          req.url = `/${name}.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [sharedHead(), cleanPagePaths()],
  root: webRoot,
  publicDir: "static",
  base: "/",
  build: {
    outDir: resolve(__dirname, "src/modules/dashboard/dist"),
    emptyOutDir: true,
    // 🚨 Один CSS на все страницы, а не по файлу на вход: ядро (67 КБ) сидит в
    // шести постраничных стилях, и каждый переход качал его заново.
    cssCodeSplit: false,
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
        unlocks: resolve(webRoot, "unlocks.html"),
        calibrator: resolve(webRoot, "calibrator.html"),
        flow: resolve(webRoot, "flow.html"),
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
      // DASHBOARD_DEV_COOKIE — сессия прода для показа через ssh-туннель: без неё
      // закрытые /api отвечают 401. Секрет живёт только в окружении запуска.
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        ...(process.env.DASHBOARD_DEV_COOKIE
          ? { headers: { cookie: process.env.DASHBOARD_DEV_COOKIE } }
          : {}),
      },
    },
  },
});
