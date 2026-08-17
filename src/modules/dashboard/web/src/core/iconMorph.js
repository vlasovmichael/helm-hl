// ─────────────────────────────────────────────────
//  Морфинг stroke-иконок: одна иконка ПЕРЕТЕКАЕТ в другую в том же слоте.
//  Ноль зависимостей (обкатано в tools/icon-morph-lab.html, там же тумблеры,
//  которыми видно вклад каждого шага).
//
//  Алгоритм, по шагам:
//    1. Каждую фигуру ресемплим в N равноудалённых точек. СВОЕГО ПАРСЕРА ПУТЕЙ
//       НЕТ и не надо: геометрию считает сам браузер (getPointAtLength).
//    2. Фигуры двух иконок паруем жадно — по центроиду и длине контура.
//       Лишние с любой стороны схлопываются в точку / вырастают из точки.
//    3. Кольца точек прокручиваем и разворачиваем до минимума суммы квадратов,
//       иначе контуры перекручиваются жгутом.
//    4. Между наборами считаем 2D Procrustes (поворот + масштаб + сдвиг) и
//       интерполируем УГОЛ, а не координаты. Отсюда «стрелка сама повернулась»
//       вместо схлопывания через центр.
//    5. Время гонит пружина, а не ease — прерванный морф сохраняет скорость.
//
//  🚨 Порядок 3 и 4 не переставлять. Прокрутка колец по СЫРОМУ расстоянию у
//  повёрнутой на 90° фигуры выбирает направление обхода наугад, и Procrustes
//  честно подгоняется под кривое соответствие. Поэтому внутри: грубый
//  Procrustes → прокрутка в выпрямленной системе → точный Procrustes.
// ─────────────────────────────────────────────────

const NS = "http://www.w3.org/2000/svg";

// Точек на фигуру. 64 — потолок разумного: на 24×24 глаз уже не отличает, а
// прокрутка колец стоит O(n²) на пару.
const POINTS = 64;

// Пружина. Подобрано в лаборатории: доезжает за ~450 мс без видимого перелёта.
const STIFFNESS = 170;
const DAMPING = 24;

// Скрытый <svg> — «линейка»: кладём туда фигуру и спрашиваем её геометрию.
// Один на документ, создаётся лениво (модуль грузится и на страницах без иконок).
let ruler = null;
function getRuler() {
  if (!ruler) {
    ruler = document.createElementNS(NS, "svg");
    ruler.setAttribute("viewBox", "0 0 24 24");
    ruler.setAttribute("aria-hidden", "true");
    ruler.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(ruler);
  }
  return ruler;
}

const isClosedEl = (el) => {
  const t = el.tagName.toLowerCase();
  if (t === "circle" || t === "ellipse" || t === "rect" || t === "polygon") return true;
  if (t === "path") return /[zZ]\s*$/.test(el.getAttribute("d") || "");
  return false;
};

/** Разметка иконки → массив фигур, каждая = n точек в плоском Float64Array. */
function sampleMarkup(markup) {
  const svg = getRuler();
  svg.innerHTML = markup;
  const out = [];
  for (const el of svg.children) {
    if (typeof el.getTotalLength !== "function") continue;
    const len = el.getTotalLength();
    if (!(len > 0)) continue;
    const closed = isClosedEl(el);
    const pts = new Float64Array(POINTS * 2);
    for (let i = 0; i < POINTS; i++) {
      // У замкнутого кольца последняя точка совпала бы с первой — делим на n.
      const t = closed ? i / POINTS : i / (POINTS - 1);
      const p = el.getPointAtLength(t * len);
      pts[i * 2] = p.x;
      pts[i * 2 + 1] = p.y;
    }
    out.push({ pts, closed, len });
  }
  svg.innerHTML = "";
  return out;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return [x / n, y / n];
}

/** Сумма квадратов между кольцом a (сдвиг off, направление dir) и кольцом b. */
function ringCost(a, b, off, dir) {
  const n = a.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = dir > 0 ? (i + off) % n : (((off - i) % n) + n) % n;
    const dx = a[j * 2] - b[i * 2];
    const dy = a[j * 2 + 1] - b[i * 2 + 1];
    s += dx * dx + dy * dy;
  }
  return s;
}

function reindex(a, off, dir) {
  const n = a.length / 2;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = dir > 0 ? (i + off) % n : (((off - i) % n) + n) % n;
    out[i * 2] = a[j * 2];
    out[i * 2 + 1] = a[j * 2 + 1];
  }
  return out;
}

/**
 * Шаг 3. Для замкнутых перебираем все n сдвигов × 2 направления, для открытых —
 * только направление обхода (у линии нет «начала по кругу»). Возвращаем
 * параметры перестановки: искать её надо на выпрямленной геометрии, а применять
 * к исходной.
 */
function findAlignment(a, b, closed) {
  const n = a.length / 2;
  let best = Infinity;
  let bo = 0;
  let bd = 1;
  for (const dir of [1, -1]) {
    if (closed) {
      for (let off = 0; off < n; off++) {
        const c = ringCost(a, b, off, dir);
        if (c < best) {
          best = c;
          bo = off;
          bd = dir;
        }
      }
    } else {
      // Открытый путь: «реверс» = пойти с конца, т.е. off = n-1.
      const o = dir > 0 ? 0 : n - 1;
      const c = ringCost(a, b, o, dir);
      if (c < best) {
        best = c;
        bo = o;
        bd = dir;
      }
    }
  }
  return { off: bo, dir: bd };
}

function degenerate([x, y]) {
  const pts = new Float64Array(POINTS * 2);
  for (let i = 0; i < POINTS; i++) {
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  }
  return { pts, closed: false, len: 0 };
}

/** Центр тяжести всей иконки — куда втягиваются лишние фигуры. */
function iconCenter(shapes) {
  if (!shapes.length) return [12, 12]; // середина viewBox 24×24
  let x = 0;
  let y = 0;
  for (const s of shapes) {
    const c = centroid(s.pts);
    x += c[0];
    y += c[1];
  }
  return [x / shapes.length, y / shapes.length];
}

/**
 * Шаг 2. Жадно: к каждой фигуре B — ближайшая свободная из A.
 *
 * Когда числа фигур не совпадают (солнце = круг + 8 лучей, луна = один
 * серп), лишние НЕ ужимаются каждая в свой центр: так восемь лучей просто
 * тают на месте восемью точками. Вместо этого они втягиваются в центр
 * иконки-цели — луч уезжает внутрь месяца, как и ждёт глаз.
 */
function pairShapes(A, B) {
  const used = new Set();
  const pairs = [];
  const centerA = iconCenter(A);
  const centerB = iconCenter(B);

  for (const b of B) {
    const cb = centroid(b.pts);
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < A.length; i++) {
      if (used.has(i)) continue;
      const ca = centroid(A[i].pts);
      const cost = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) + Math.abs(A[i].len - b.len) * 0.35;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    if (best >= 0) {
      used.add(best);
      pairs.push([A[best], b]);
    } else {
      pairs.push([degenerate(centerA), b]); // вырастает из центра исходной иконки
    }
  }
  for (let i = 0; i < A.length; i++) {
    if (!used.has(i)) pairs.push([A[i], degenerate(centerB)]);
  }
  return pairs;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Шаг 4. Подобие без отражений, переводящее A в B. Возвращаем ПАРАМЕТРЫ, а не
 * матрицу: угол дальше интерполируется отдельно, в этом весь смысл.
 */
function procrustes(A, B) {
  const n = A.length / 2;
  const [cax, cay] = centroid(A);
  const [cbx, cby] = centroid(B);
  let Sxx = 0;
  let Sxy = 0;
  let na = 0;
  for (let i = 0; i < n; i++) {
    const ax = A[i * 2] - cax;
    const ay = A[i * 2 + 1] - cay;
    const bx = B[i * 2] - cbx;
    const by = B[i * 2 + 1] - cby;
    Sxx += ax * bx + ay * by;
    Sxy += ax * by - ay * bx;
    na += ax * ax + ay * ay;
  }
  return {
    theta: Math.atan2(Sxy, Sxx),
    s: na > 1e-9 ? clamp(Math.hypot(Sxx, Sxy) / na, 0.2, 5) : 1,
    ca: [cax, cay],
    cb: [cbx, cby],
  };
}

/** T: переносит A в систему координат B (чтобы кольца сравнивались без поворота). */
function applyT(A, { theta, s, ca, cb }) {
  const n = A.length / 2;
  const out = new Float64Array(n * 2);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  for (let i = 0; i < n; i++) {
    const x = (A[i * 2] - ca[0]) * s;
    const y = (A[i * 2 + 1] - ca[1]) * s;
    out[i * 2] = x * c - y * sn + cb[0];
    out[i * 2 + 1] = x * sn + y * c + cb[1];
  }
  return out;
}

/** T⁻¹: тянет B обратно в систему A, чтобы лерп шёл по выпрямленным фигурам. */
function unapplyT(B, { theta, s, ca, cb }) {
  const n = B.length / 2;
  const out = new Float64Array(n * 2);
  const c = Math.cos(-theta);
  const sn = Math.sin(-theta);
  const inv = 1 / s;
  for (let i = 0; i < n; i++) {
    const x = (B[i * 2] - cb[0]) * inv;
    const y = (B[i * 2 + 1] - cb[1]) * inv;
    out[i * 2] = x * c - y * sn + ca[0];
    out[i * 2 + 1] = x * sn + y * c + ca[1];
  }
  return out;
}

/** Пара фигур → связка {src, dst, T}, готовая к покадровой отрисовке. */
function solvePair(a, b) {
  const closed = a.closed && b.closed;
  let src = a.pts;
  if (a.len > 0 && b.len > 0) {
    // Выпрямляем A по грубой оценке — только чтобы честно сравнить кольца…
    const probe = applyT(src, procrustes(src, b.pts));
    // …а найденную перестановку применяем к ИСХОДНОЙ геометрии.
    const { off, dir } = findAlignment(probe, b.pts, closed);
    src = reindex(src, off, dir);
  }
  const T = procrustes(src, b.pts);
  return { src, dst: unapplyT(b.pts, T), T, closed };
}

// Пара «откуда→куда» разбирается один раз на всё приложение: ховер по навбару
// дёргает это на каждое наведение, а результат для одной пары разметок всегда
// один и тот же. Кадры из него только ЧИТАЮТСЯ (frameToPath ничего не меняет),
// поэтому запись безопасно делить между иконками.
const morphCache = new Map();

function buildMorph(fromMarkup, toMarkup) {
  const key = fromMarkup + " " + toMarkup;
  let parts = morphCache.get(key);
  if (!parts) {
    parts = pairShapes(sampleMarkup(fromMarkup), sampleMarkup(toMarkup)).map(([a, b]) =>
      solvePair(a, b),
    );
    morphCache.set(key, parts);
  }
  return parts;
}

const round = (v) => Math.round(v * 100) / 100 + " ";

/** Кадр в момент t: лерп в выпрямленной системе + частично применённое подобие. */
function frameToPath({ src, dst, T, closed }, t) {
  const n = src.length / 2;
  const { theta, s, ca, cb } = T;
  const ang = theta * t;
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const st = 1 + (s - 1) * t;
  const dx = (cb[0] - ca[0]) * t;
  const dy = (cb[1] - ca[1]) * t;

  let d = "";
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const lx = src[i * 2] + (dst[i * 2] - src[i * 2]) * t;
    const ly = src[i * 2 + 1] + (dst[i * 2 + 1] - src[i * 2 + 1]) * t;
    const px = lx - ca[0];
    const py = ly - ca[1];
    const x = (px * cs - py * sn) * st + ca[0] + dx;
    const y = (px * sn + py * cs) * st + ca[1] + dy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    d += (i === 0 ? "M" : "L") + round(x) + round(y);
  }
  // 🚨 Схлопнувшуюся фигуру НЕЛЬЗЯ оставлять нулевым путём: stroke-linecap:round
  // рисует её жирной ТОЧКОЙ. Именно так восемь лучей солнца оставались висеть
  // крапинами вокруг месяца. Пустой d не рисует ничего.
  if (maxX - minX < 0.15 && maxY - minY < 0.15) return "";
  return closed ? d + "Z" : d;
}

// ── Планировщик: один rAF на все иконки страницы ──
const live = new Set();
let raf = 0;
let lastFrame = 0;

function tick(now) {
  // Вкладка вернулась из фона — dt не даём взорваться, иначе пружина «стрельнёт».
  const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
  lastFrame = now;
  let busy = false;
  for (const m of live) if (!m._step(dt)) busy = true;
  raf = busy ? requestAnimationFrame(tick) : 0;
}

function schedule() {
  if (!raf) {
    lastFrame = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

// 🚨 В фоновой вкладке rAF не вызывается ВООБЩЕ (не «реже» — ноль кадров).
// Без этого морф, начатый перед уходом на другую вкладку, застывал на
// середине: иконка оставалась покорёженной навсегда, пружина уже не тикала.
// Уходим в фон — доводим всё до конца сразу.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    for (const m of live) m._settle();
    live.clear();
    raf = 0;
  });
}

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Повесить морф на существующий <svg>. Внутренности svg заменяются на <path>'ы,
 * поэтому окраска должна идти от CSS (fill:none; stroke:currentColor) — как в
 * .nav-ico.
 *
 * @param {SVGElement} svg — целевой <svg viewBox="0 0 24 24">
 * @param {Record<string,string>} icons — карта «ключ → внутренняя разметка SVG»
 * @param {string} initial — стартовый ключ
 * @returns {{to:(key:string)=>void, current:()=>string, destroy:()=>void}}
 */
export function createMorphIcon(svg, icons, initial) {
  let key = initial;
  let parts = buildMorph(icons[initial], icons[initial]);
  let t = 1;
  let v = 0;

  // В покое держим ИСХОДНУЮ разметку, а не полилинию из 64 точек: движок
  // спрямляет кривые хордами (на 16px это ~0.1px, но зачем), да и `d` худеет
  // с ~800 символов до ~60. Флаг помнит, что в svg сейчас чужие узлы
  // (<rect>/<line>/<circle>), которые paint обязан снести перед своими <path>.
  let resting = true;

  const snap = () => {
    svg.innerHTML = icons[key];
    resting = true;
  };

  const paint = (at) => {
    if (resting) {
      svg.innerHTML = "";
      resting = false;
    }
    const ds = parts.map((p) => frameToPath(p, at));
    // Число фигур в паре постоянно — переиспользуем узлы, а не пересоздаём DOM.
    while (svg.childElementCount > ds.length) svg.lastElementChild.remove();
    while (svg.childElementCount < ds.length) svg.appendChild(document.createElementNS(NS, "path"));
    for (let i = 0; i < ds.length; i++) svg.children[i].setAttribute("d", ds[i]);
  };

  const api = {
    to(next) {
      if (next === key || !icons[next]) return;
      if (t < 1) {
        // Прерывание на лету: текущий кадр становится новым стартом. Скорость НЕ
        // сбрасываем — иначе на быстрых кликах видно рывок.
        // Пустые пути (уже схлопнувшиеся фигуры) выбрасываем: иначе они уедут
        // в пересборку как вырожденные фигуры в точке (0,0) и потянут морф туда.
        const frozen = parts.map((p) => frameToPath(p, t)).filter(Boolean);
        const svgRuler = getRuler();
        svgRuler.innerHTML = frozen.map((d) => `<path d="${d}"/>`).join("");
        const A = [];
        for (const el of svgRuler.children) {
          const len = el.getTotalLength();
          const closed = /[zZ]\s*$/.test(el.getAttribute("d") || "");
          const pts = new Float64Array(POINTS * 2);
          for (let i = 0; i < POINTS; i++) {
            const p = el.getPointAtLength((closed ? i / POINTS : i / (POINTS - 1)) * len);
            pts[i * 2] = p.x;
            pts[i * 2 + 1] = p.y;
          }
          A.push({ pts, closed, len });
        }
        svgRuler.innerHTML = "";
        parts = pairShapes(A, sampleMarkup(icons[next])).map(([a, b]) => solvePair(a, b));
      } else {
        parts = buildMorph(icons[key], icons[next]);
      }
      key = next;
      t = 0;
      if (reducedMotion()) {
        t = 1;
        snap();
        return;
      }
      paint(0);
      live.add(api);
      schedule();
    },

    current: () => key,

    destroy() {
      live.delete(api);
    },

    /** Мгновенно доехать в цель (уход вкладки в фон, prefers-reduced-motion). */
    _settle() {
      t = 1;
      v = 0;
      snap();
    },

    _step(dt) {
      if (t >= 1) {
        live.delete(api);
        return true;
      }
      v += (-STIFFNESS * (t - 1) - DAMPING * v) * dt;
      t += v * dt;
      if (t > 1 || (Math.abs(1 - t) < 0.001 && Math.abs(v) < 0.01)) {
        t = 1;
        v = 0;
        snap(); // доехали — возвращаем настоящие кривые
        return true;
      }
      paint(t);
      return false;
    },
  };

  snap();
  return api;
}
