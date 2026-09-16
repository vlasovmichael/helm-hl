// ─────────────────────────────────────────────────
//  Вход страниц под роутером: OI и Ledger.
//
//  Шапка, тема и подсказки живут здесь и переживают переходы; экран рисует
//  модуль страницы и сам гасит за собой таймеры и сокет.
//
//  🚨 Страница идёт под роутер только после того, как каждый её таймер, сокет
//  и наблюдатель получил остановку: иначе на возврате они копятся.
// ─────────────────────────────────────────────────
import "./src/styles/core.scss";

import { mountTopnav } from "./src/core/topnav.js";
import { bindTheme } from "./src/core/shell.js";
import { route, start } from "./src/core/router.js";

mountTopnav("");
bindTheme();

route("/oi", () => import("./oi.js"));
route("/ledger", () => import("./ledger.js"));
route("/statistics", () => import("./statistics.js"));
route("/lab", () => import("./lab.js"));
route("/journal", () => import("./journal.js"));

start(document.getElementById("outlet"));
