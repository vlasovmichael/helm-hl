// ─────────────────────────────────────────────────────────────────────────────
//  tgChannelScreen — первичный отсев сигнальных телеграм-каналов.
//
//  ЗАЧЕМ: прогон канала по свечам стоит вечер, а большинство каналов отсеивается
//  за минуту по их СОБСТВЕННЫМ числам, без единой свечи. Отсюда две ступени:
//
//    1. ЧТО ВООБЩЕ ПУБЛИКУЕТСЯ. Канал, у которого в постах нет ни входа, ни
//       стопа, а только «Target 1 ✅ … 145% profit», проверить невозможно в
//       принципе — и это уже вердикт для подписчика: результат не проверяем,
//       а показывают только победы. Отдельная колонка «витрина».
//    2. ГЕОМЕТРИЯ. Там, где вход и стоп есть, считается медианный R:R по
//       собственным числам канала. Если цель ближе стопа, никакой винрейт
//       не спасает: замер случайного входа (05.09, 168 864 сделки) даёт 79.5%
//       побед при R:R 0.25 и всё равно минус на величину издержек.
//
//  Разбор поста — сначала регулярками (дёшево), и только непонятое уходит в
//  локальную модель через ollama. Формат у каждого канала свой, поэтому без
//  модели генерик-парсер выродился бы в свалку частных случаев.
//
//  Запуск:  node tools/tgChannelScreen.mjs [канал ...] [--llm] [--json out.json]
//           без имён — берёт всё, что лежит в data/tg-signals/*.raw.json
//  ENV:     OLLAMA_HOST (умолчание 127.0.0.1:11435 — туннель к Ораклу),
//           OLLAMA_MODEL (умолчание qwen3:8b)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('data', 'tg-signals');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const USE_LLM = process.argv.includes('--llm');
const OLLAMA = (process.env.OLLAMA_HOST || '127.0.0.1:11435').replace(/^https?:\/\//, '');
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

// ── Разбор поста регулярками ────────────────────────────────────────────────
// Не пытаемся покрыть все формы: задача — отделить пост с ТОРГУЕМЫМ сигналом
// (сторона + вход + стоп) от витрины и от болтовни. Спорное уходит в модель.

const RE_SIDE = /\b(LONG|SHORT|BUY|SELL|ЛОНГ|ШОРТ|ПОКУПК|ПРОДАЖ)\b/i;
const RE_COIN = /(?:^|[\s#$])([A-Z]{2,10})(?:\/?USDT|\/USD|\b)/;
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)`;
const RE_ENTRY = new RegExp(String.raw`(?:entry|вход|buy\s*zone|entry\s*zone|цена\s*входа|@)\D{0,12}${NUM}`, 'i');
const RE_STOP = new RegExp(String.raw`(?:stop\s*-?\s*loss|stoploss|\bSL\b|стоп|стоп-?лосс)\D{0,12}${NUM}`, 'i');
const RE_TGT = new RegExp(String.raw`(?:target|take\s*profit|\bTP\s*\d?\b|цель|тейк)\D{0,12}${NUM}`, 'i');
// Витрина: отчёт о взятых целях и процент профита, без входа и стопа.
// Галочка встречается и до слова, и после («Take-Profit target 5 ✅»), поэтому
// порядок не фиксируем.
const RE_SHOWCASE = /(?:✅|✔️)[^\n]{0,40}(?:target|цель)|(?:target|цель)[^\n]{0,40}(?:✅|✔️)|\d+(?:\.\d+)?%\s*(?:profit|прибыл)|profit\s*\(\d+x\)/i;

// 🚨 Разделитель тысяч. Каналы пишут «$3,387.29», и наивная замена запятой на
// точку давала 3.387 — отсюда в первом прогоне взялись R:R 0.00 и 20.4.
// Правило: запятая перед ТРЕМЯ цифрами и не последняя — разделитель тысяч.
function num(s) {
  if (s == null) return null;
  let t = String(s).replace(/[\s$€£]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');   // 3,387.29
  else t = t.replace(',', '.');                                          // 1,35 → 1.35
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function parseRegex(text) {
  const t = text.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
  const side = t.match(RE_SIDE)?.[1]?.toUpperCase() ?? null;
  const entry = num(t.match(RE_ENTRY)?.[1]);
  const stop = num(t.match(RE_STOP)?.[1]);
  const target = num(t.match(RE_TGT)?.[1]);
  const coin = t.match(RE_COIN)?.[1] ?? null;
  return { coin, side, entry, stop, target, showcase: RE_SHOWCASE.test(t) };
}

// ── Разбор моделью ──────────────────────────────────────────────────────────
// Батчами: один вызов на 8 постов, иначе 5000 постов канала это часы. Модель
// обязана вернуть массив той же длины — расхождение считаем провалом батча и
// откатываемся на регулярки, а не подставляем ответы наугад.
const PROMPT = `Ты извлекаешь торговые сигналы из постов телеграм-каналов.
Для КАЖДОГО поста верни объект: {"i":<номер>,"coin":<тикер или null>,"side":"LONG"|"SHORT"|null,
"entry":<число или null>,"stop":<число или null>,"target":<число или null>}
Правила: только то, что ЯВНО написано в посте; ничего не додумывай.
Если пост — отчёт о результате («Target 1 ✅», «+145% profit»), а цены входа нет, ставь entry:null.
Ответь ТОЛЬКО JSON-массивом, без пояснений.`;

// 🚨 Модель ВЫДУМЫВАЕТ числа. На витринном посте «Take-Profit target 5 ✅ /
// Profit: 39.50%» qwen3:8b вернула entry=2, target=5 — приняла НОМЕР цели за
// цену. Поэтому любое извлечённое число проверяется на дословное присутствие
// в исходном тексте; не нашлось — выбрасываем. Без этой проверки скринер
// наполнился бы сигналами, которых в постах нет.
function seenInText(text, v) {
  if (v == null) return false;
  const s = String(v);
  if (text.includes(s)) return true;
  // «3387.29» в посте может стоять как «3,387.29», а «0.43» — как «0.4300».
  const plain = text.replace(/,/g, '');
  if (plain.includes(s)) return true;
  const n = Number(v);
  return Number.isFinite(n) && new RegExp(`\\b${n.toString().replace('.', '\\.')}0*\\b`).test(plain);
}

async function parseLLM(posts) {
  const body = posts.map((p, i) => `[${i}] ${p.slice(0, 350)}`).join('\n---\n');
  let j;
  try {
    const res = await fetch(`http://${OLLAMA}/api/generate`, {
      method: 'POST',
      // Оракл считает на CPU: батч из трёх постов идёт ~20-25с, запас берём щедрый.
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({ model: MODEL, prompt: `${PROMPT}\n\n${body}`, stream: false, think: false, format: 'json' }),
    });
    j = await res.json();
  } catch { return null; }
  try {
    const raw = JSON.parse(j.response);
    let arr = Array.isArray(raw) ? raw : raw.signals ?? raw.result ?? (typeof raw === 'object' ? [raw] : null);
    if (!Array.isArray(arr) || arr.length !== posts.length) return null;
    // Сверка с источником — то, ради чего всё это.
    return arr.map((o, i) => {
      if (!o || typeof o !== 'object') return null;
      const keep = {};
      for (const f of ['entry', 'stop', 'target']) keep[f] = seenInText(posts[i], o[f]) ? o[f] : null;
      keep.side = o.side; keep.coin = o.coin;
      return keep;
    });
  } catch { return null; }
}

// ── Прогон канала ───────────────────────────────────────────────────────────

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function screen(channel) {
  const rows = JSON.parse(readFileSync(join(DIR, `${channel}.raw.json`), 'utf8'));
  const texts = rows.map((r) => r.text || '').filter((t) => t.length > 20);
  const parsed = texts.map(parseRegex);

  // Пост «похож на сигнал», если названы сторона и монета: дальше вопрос лишь
  // в том, дали ли нам вход со стопом или показали результат.
  const signalish = parsed.filter((p) => p.side && p.coin);
  const actionable = signalish.filter((p) => p.entry && p.stop);
  // Витрина не обязана называть сторону: «#TRX/USDT Take-Profit target 5 ✅».
  const showcase = parsed.filter((p) => p.coin && !p.entry && p.showcase);

  // Модель зовём только там, где регулярки увидели сигнал, но не нашли чисел.
  let recovered = 0;
  if (USE_LLM) {
    const idx = [];
    parsed.forEach((p, i) => { if (p.side && p.coin && !(p.entry && p.stop)) idx.push(i); });
    for (let i = 0; i < idx.length; i += 3) {
      const chunk = idx.slice(i, i + 3);
      const out = await parseLLM(chunk.map((k) => texts[k]));
      if (!out) continue;
      out.forEach((o, k) => {
        if (!o) return;
        const p = parsed[chunk[k]];
        if (o?.entry && o?.stop && !(p.entry && p.stop)) {
          p.entry = num(o.entry); p.stop = num(o.stop); p.target = num(o.target) ?? p.target;
          recovered++;
        }
      });
      process.stderr.write(`\r${channel}: модель разобрала ${recovered}, батч ${i / 3 + 1}/${Math.ceil(idx.length / 3)}   `);
    }
    if (idx.length) process.stderr.write('\n');
  }

  const act = parsed.filter((p) => p.side && p.coin && p.entry && p.stop);
  // R:R по собственным числам канала. Цель берём первую названную — она же
  // самая близкая, то есть считаем В ПОЛЬЗУ канала.
  const rrs = act
    .filter((p) => p.target)
    .map((p) => Math.abs(p.target - p.entry) / Math.abs(p.entry - p.stop))
    .filter((v) => Number.isFinite(v) && v > 0 && v < 50);
  // Медиана на горстке наблюдений — шум: не печатаем её вовсе.
  const rr = rrs.length >= 20 ? median(rrs) : null;

  return {
    channel,
    posts: texts.length,
    signalish: signalish.length,
    actionable: act.length,
    showcase: showcase.length,
    recovered,
    medianRR: rr,
    breakevenWR: rr == null ? null : (100 / (1 + rr)),
  };
}

const names = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.json'));
const channels = names.length
  ? names
  : readdirSync(DIR).filter((f) => f.endsWith('.raw.json')).map((f) => f.replace('.raw.json', ''));

const out = [];
for (const c of channels) {
  try { out.push(await screen(c)); } catch (e) { console.error(`${c}: ${e.message}`); }
}

console.log('\nканал                    постов  сигнал.  торгуемых  витрина  медиана R:R  нужный WR  вердикт');
for (const r of out.sort((a, b) => b.actionable - a.actionable)) {
  let verdict;
  if (r.actionable < 20) verdict = 'НЕЧЕГО ПРОВЕРЯТЬ (нет входа/стопа)';
  else if (r.medianRR == null) verdict = 'нет целей — R:R не считается';
  else if (r.medianRR < 1) verdict = `ОТСЕВ: цель ближе стопа`;
  else verdict = 'кандидат на прогон по свечам';
  console.log(
    `${r.channel.padEnd(24)} ${String(r.posts).padStart(6)}  ${String(r.signalish).padStart(7)}  ` +
    `${String(r.actionable).padStart(9)}  ${String(r.showcase).padStart(7)}  ` +
    `${(r.medianRR == null ? '—' : r.medianRR.toFixed(2)).padStart(11)}  ` +
    `${(r.breakevenWR == null ? '—' : r.breakevenWR.toFixed(1) + '%').padStart(9)}  ${verdict}`,
  );
}

const jsonOut = arg('json', null);
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 2)); console.error(`\n→ ${jsonOut}`); }
