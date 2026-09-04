// ─────────────────────────────────────────────────────────────────────────────
//  tgSignalsFetch — выгрузка публичной истории TG-канала через t.me/s/<name>
//
//  Без Telegram API и без аккаунта: превью-страница канала отдаёт по 20 постов
//  и листается назад через ?before=<id>. Нужны только текст, id и время поста —
//  картинки не тянем, разбор идёт по тексту.
//
//  Запуск:  node tools/tgSignalsFetch.mjs <channel> [--max-pages 200]
//  Пишет:   data/tg-signals/<channel>.raw.json   [{id, ts, text}]
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CHANNEL = process.argv[2];
if (!CHANNEL) {
  console.error("Укажи канал: node tools/tgSignalsFetch.mjs <channel>");
  process.exit(1);
}
const argN = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? +process.argv[i + 1] : d; };
const MAX_PAGES = argN("max-pages", 300);
const DIR = join("data", "tg-signals");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(before) {
  const url = `https://t.me/s/${CHANNEL}${before ? `?before=${before}` : ""}`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.text();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const unescapeHtml = (s) => s
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

// Один пост = блок от data-post до следующего data-post. Внутри вытаскиваем
// текст и datetime; посты без текста (голая картинка) сохраняем с пустым text —
// они нужны, чтобы не терять нумерацию.
function parse(html) {
  const out = [];
  // Границы постов — по data-post: вложенные div'ы носят тот же префикс класса,
  // так что делить по классу нельзя (время уезжает в следующий блок).
  const idx = [...html.matchAll(/data-post="[^/]+\/(\d+)"/g)];
  for (let i = 0; i < idx.length; i++) {
    const p = html.slice(idx[i].index, i + 1 < idx.length ? idx[i + 1].index : html.length);
    const id = +idx[i][1];
    const ts = p.match(/<time[^>]*datetime="([^"]+)"/)?.[1] || null;
    const body = p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_(?:reply_markup|footer|bubble_end)|<\/div>)/);
    const text = body ? unescapeHtml(body[1]).trim() : "";
    out.push({ id, ts, text });
  }
  return out;
}

const all = new Map();
let before = null;
for (let i = 0; i < MAX_PAGES; i++) {
  const html = await page(before);
  if (!html) { console.error(`страница не отдалась (before=${before}), останавливаюсь`); break; }
  const msgs = parse(html);
  if (!msgs.length) break;
  const fresh = msgs.filter((m) => !all.has(m.id));
  for (const m of msgs) all.set(m.id, m);
  const minId = Math.min(...msgs.map((m) => m.id));
  process.stderr.write(`\r${all.size} постов, дошли до #${minId} (${msgs[0]?.ts?.slice(0, 10)})   `);
  if (!fresh.length || before === minId) break;   // дальше история не листается
  before = minId;
  await sleep(400);
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const rows = [...all.values()].sort((a, b) => a.id - b.id);
const file = join(DIR, `${CHANNEL}.raw.json`);
writeFileSync(file, JSON.stringify(rows, null, 1));
console.error(`\n${rows.length} постов → ${file}`);
console.error(`период: ${rows[0]?.ts} … ${rows.at(-1)?.ts}`);
