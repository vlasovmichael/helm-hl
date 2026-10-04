/* global document, window, getComputedStyle */
/* Собранная визуальная сеть: изолирована от бота и реального API. */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2), out = args.find((x) => !x.startsWith("--"));
const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : process.cwd();
if (!out) throw new Error("node scripts/snapshotDash.mjs <каталог> [--project путь] [--twice]");
const twice = args.includes("--twice"), legacy = args.includes("--legacy"), dist = join(project, "src/modules/dashboard/dist");
const port = Number(process.env.KIT_COLORS_PORT || 4174);
const defaultPages = ["index", "orderbook", "orderbook-sim", "journal", "ledger", "statistics", "lab", "oi", "calibrator", "levels", "login", "ticket"];
const pages = process.env.KIT_COLORS_PAGES?.split(",").filter(Boolean) || defaultPages;
const routerPages = new Set(["index", "oi", "ledger", "statistics", "lab", "journal"]);
const pageStyleSelector = { index:".card", orderbook:".ob-terminal", "orderbook-sim":".obs-book", journal:".j-vh", ledger:".ledger-head", statistics:".pnl-hero", lab:".lab-meta", oi:".oi-coin", calibrator:".calib-hero", levels:".lv-context", login:".login-card", ticket:".tk-btn" };
const now = Date.parse("2026-10-04T10:00:00Z");
const points = Array.from({ length: 36 }, (_, i) => ({ t: now - (35-i)*3600000, ts: now-(35-i)*3600000, px: 62000+i*55, oi: 120000+i*500, oiUsd: 7.4e9+i*8e6, f: .0001, v: 2e8, equity: 10000+i*22 }));
const oi = { oi: 120000, oiUsd: 7.6e9, at: now, windows: [{ label: "24h", oiPct: 3.1, mode: "new-longs" }] };
function api(url) {
  const path = new URL(url).pathname;
  if (path === "/api/levels") return { coin:"BTC", tf:"1h", price:63920, candles:points.map(p=>({time:Math.floor(p.t/1000),open:p.px-45,high:p.px+110,low:p.px-95,close:p.px})), zones:[{name:"Support",lo:63200,hi:63400,strength:5,sources:["swing"]},{name:"Resistance",lo:64500,hi:64700,strength:4,sources:["round"]}], thin:[], btc:{corr:.81,beta:1.12,windows:[{label:"24h",btc:1.2,coin:1.6}]}, oi };
  if (path === "/api/levels/oi") return { oi };
  if (path === "/api/levels/journal") return { open:2, rows:[], summary:[] };
  if (path === "/api/oi-collector/overview") return { ok:true, span:{firstT:now-36*3600000,lastT:now,count:36},has24h:true,coins:["BTC","ETH","SOL"].map((coin,i)=>({coin,oiUsd:7.6e9-i*1e9,dOi24hPct:3.1-i,dOi1hPct:.4,px:63920/(i+1),dPx24hPct:1.8,f:.0001,v:2e8})) };
  if (path === "/api/oi-collector/coin") return { ok:true,hours:24,rawCount:points.length,points };
  if (path === "/api/carry") return { ok:true,fees:{source:"fixture",perpTaker:3.5,spotTaker:10},rows:[{coin:"BTC",aprNow:12.4,aprAvg:8.2,positiveShare:.68,basisBp:4,usdPerDayPer1k:1.2,breakEvenDaysTaker:8,breakEvenDaysMaker:4}] };
  if (path === "/api/history") return { points };
  if (path === "/api/pnl-summary") return { total:792,unrealized:115,trades:28,wins:18,winRate:.64,avg:28,best:143,worst:-71,funding:12,utilization:.4 };
  if (path === "/api/calibrator") { const grid=[1,2].flatMap(mt=>[1,2].map(ms=>({mt,ms,needT:57,needM:51,gapT:7,gapM:3,eT:12,eM:18,ci:4,hit:62,tgt:mt*100,stp:ms*100}))); return {mult:[1,2],coins:{BTC:{atr:43,costTaker:7,costMaker:3,shareTaker:16,shareMaker:7,px:63920,vlm:2e9,grid},ETH:{atr:51,costTaker:7,costMaker:3,shareTaker:14,shareMaker:6,px:3200,vlm:1e9,grid}}}; }
  if (path === "/api/ticket/context") return { coins:["BTC","ETH","SOL"],price:63920 };
  if (path === "/api/ledger") return { live:false,months:[],startDate:"2025-01-01" };
  return { ok:true,points,rows:[],coins:["BTC","ETH","SOL"],data:[] };
}
const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2",".png":"image/png"};
function server() { return createServer((req,res)=>{ let name=normalize(decodeURIComponent(new URL(req.url,"http://x").pathname)).replace(/^\/+/,"")||"index.html"; if(routerPages.has(name)) name=`${name}.html`; const file=join(dist,name); if(!file.startsWith(dist)||!existsSync(file)||statSync(file).isDirectory()) return res.writeHead(404).end(); res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream"});res.end(readFileSync(file)); }); }
const shorten = (value) => String(value).replace(/\?.*/, "");
function diagnostics(page, label) {
  const events = [];
  const note = (kind, value) => events.push({ kind, value: String(value).slice(0, 600) });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") note(`console:${msg.type()}`, msg.text());
  });
  page.on("pageerror", (err) => note("pageerror", err.stack || err.message));
  page.on("requestfailed", (req) => note("requestfailed", `${req.method()} ${shorten(req.url())}: ${req.failure()?.errorText || "unknown"}`));
  page.on("request", (req) => note("request", `${req.method()} ${shorten(req.url())}`));
  page.on("websocket", (ws) => note("websocket", shorten(ws.url())));
  return {
    assertClean() {
      const bad = events.filter((e) => e.kind === "pageerror" || e.kind === "requestfailed");
      if (bad.length) throw Error(`${label}: browser diagnostics ${JSON.stringify(bad)}`);
    },
    save(file) { writeFileSync(file, JSON.stringify(events, null, 2)); },
  };
}
async function capture(context,theme,width,name,file) {
  const page=await context.newPage();
  await page.setViewportSize({width,height:900});
  const log=diagnostics(page,`${name}/${theme}/${width}`);
  // The fixture deliberately freezes time and animation frames.  That makes a
  // perpetual render loop visible in diagnostics without letting it make a
  // screenshot timing-dependent; the app itself still renders its first frame.
  await page.addInitScript(({ theme, status })=>{
    localStorage.setItem("hl-scanner-theme",theme);document.documentElement?.dataset && (document.documentElement.dataset.theme=theme);
    // Страницы с ?mock=1 рисуют демо-графики. Их генератор должен быть таким
    // же фиксированным, как API и часы, иначе сеть сравнивает два разных рынка.
    let seed=0x6d2b79f5;
    Math.random=()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296};
    const rafs=[]; window.__kitSnapshot={rafs,websockets:[]};
    window.requestAnimationFrame=(fn)=>{rafs.push(String(fn).slice(0,120));return rafs.length};
    window.cancelAnimationFrame=()=>{};
    class FixtureWebSocket {
      static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
      constructor(url){this.url=url;this.readyState=0;this._ls={};window.__kitSnapshot.websockets.push(url);
        queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this._emit("open",{});
          if(String(url).startsWith("ws:"))this._emit("message",{data:JSON.stringify({type:"status",data:status})});});}
      addEventListener(type,fn){(this._ls[type]??=[]).push(fn)} removeEventListener(type,fn){this._ls[type]=(this._ls[type]??[]).filter(x=>x!==fn)}
      _emit(type,event){this[`on${type}`]?.(event);for(const fn of this._ls[type]??[])fn.call(this,event)} send(){} close(){this.readyState=3;this._emit("close",{})}
    }
    window.WebSocket=FixtureWebSocket;
  },{theme,status:{equity:10048,sessionProfit:48,sessionStartEquity:10000,uptimeMin:42,available:8100,activePosition:null,manualPositions:[],runtimeBans:[],btcLivePrice:63920,hotMovers:{ts:now,universeSize:3,signals:[]},dataHealth:{overall:"ok",checks:[]}}});
  await page.route("**/api/**",r=>r.fulfill({contentType:"application/json",body:JSON.stringify(api(r.request().url()))}));
  const trace=join(out,`trace-${name}-${theme}-${width}.zip`); await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  try {
  // index is the History-API application: /index.html is not a registered
  // route and used to redirect to itself forever. Express serves it at /.
  const target=routerPages.has(name) ? `/${name==="index" ? "" : name}?snapshot=1` : `/${name}.html`;
  await page.clock.install({time:now});
  await page.goto(`http://127.0.0.1:${port}${target}`,{waitUntil:"domcontentloaded",timeout:10000});
  // Динамические моки и графики должны закончить импорт до фиксации первого кадра.
  await page.waitForLoadState("networkidle",{timeout:10000});
  await page.clock.runFor(100);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({content:"*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"});
  // Дождаться следующего композитного кадра, не двигая замороженные часы.
  await page.waitForTimeout(250);
  const guard=await page.evaluate((selector)=>{const body=getComputedStyle(document.body),p=document.createElement("i");p.style.background="var(--ground)";document.body.append(p);const ground=getComputedStyle(p).backgroundColor;p.remove();return {overlay:!!document.querySelector("vite-error-overlay"),ground:body.backgroundColor===ground,styled:!!document.querySelector(selector),text:document.body.innerText.length}},pageStyleSelector[name]);
  const runtime=await page.evaluate(()=>window.__kitSnapshot);
  if(guard.overlay||(!legacy&&!guard.ground)||!guard.styled||guard.text<40) throw Error(`${name}/${theme}/${width}: invalid screen ${JSON.stringify({guard,runtime})}`);
  await page.screenshot({path:file,fullPage:false,timeout:5000}); const colors=Number(execFileSync("identify",["-format","%k",file],{encoding:"utf8"})); if(colors<50) throw Error(`${name}/${theme}/${width}: only ${colors} colours`);
  log.assertClean(); log.save(`${file}.network.json`);
  } finally { await context.tracing.stop({path:trace}); await page.close(); }
}
execFileSync("npm",["run","build:dash"],{cwd:project,stdio:"inherit"}); mkdirSync(out,{recursive:true}); const srv=server(); await new Promise(ok=>srv.listen(port,"127.0.0.1",ok));
const browser=await chromium.launch({headless:true}), context=await browser.newContext();
try { for(const theme of ["light","dark"])for(const width of [390,1280])for(const name of pages)for(let run=0;run<(twice?2:1);run++){const dir=twice?join(out,`run-${run+1}`):out;mkdirSync(dir,{recursive:true});console.log(`[snapshot ${run+1}] ${name} ${theme} ${width}`);await capture(context,theme,width,name,join(dir,`${name}-${theme}-${width}.png`));} } finally { await context.close(); await browser.close(); await new Promise(ok=>srv.close(ok)); }
