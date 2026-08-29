# ─────────────────────────────────────────────────────────────────────────────
#  «Сколько осталось на столе» — описательный замер хода цены ПОСЛЕ моего выхода.
#
#  ЧТО СЧИТАЕМ. Для каждого закрытого раунд-трипа берём цену и время выхода и
#  смотрим, куда ушла цена В НАПРАВЛЕНИИ ЗАКРЫТОЙ ПОЗИЦИИ за H часов после:
#     drift = sgn * (close(exit+H) − exit_px) / exit_px * 100
#  drift > 0 ⇒ терпение добавило бы; drift < 0 ⇒ выход спас.
#
#  ЗАЧЕМ БЕЙЗЛАЙН. «После выхода цена шла дальше» само по себе не значит НИЧЕГО:
#  если монета в этот период просто росла, то же самое покажет и случайный
#  момент времени. Поэтому на каждую сделку берём K случайных моментов по ТОЙ ЖЕ
#  монете в ТОМ ЖЕ окне и считаем тот же drift той же стороной. Результат =
#  разница (мой выход − случайный момент). Ноль = мой выход не отличается от
#  случайного, то есть «недобираю» — иллюзия.
#
#  CI — КЛАСТЕРНЫЙ ПО ДНЯМ. Наивный бутстрап по сделкам врал в 11× на MTF-замере
#  (память mtf_alignment_backtest): сделки одного дня коррелированы через общий
#  ход рынка. Ресэмплим ДНИ целиком.
# ─────────────────────────────────────────────────────────────────────────────
import json, glob, sys, random, statistics as st
from datetime import datetime, timezone
from bisect import bisect_left, bisect_right

INTERVAL = sys.argv[1] if len(sys.argv) > 1 else '15m'
BAR_MS = {'15m': 900_000, '1h': 3_600_000}[INTERVAL]
HORIZONS = [1, 4, 24] if INTERVAL == '15m' else [4, 24, 72]
K_BASE = 20
random.seed(20260829)

rts = json.load(open('rts.json'))
C = {}
for f in glob.glob(f'candles_{INTERVAL}/*.json'):
    coin = f.split('/')[-1][:-5]
    rows = json.load(open(f))
    if rows: C[coin] = (rows, [r[0] for r in rows])

def window(coin, t0, hours):
    """бары в (t0, t0+hours]; None если окно не покрыто данными"""
    d = C.get(coin)
    if not d: return None
    rows, ts = d
    if t0 < ts[0] or t0 + hours*3600_000 > ts[-1] + BAR_MS: return None
    i = bisect_right(ts, t0)
    j = bisect_right(ts, t0 + hours*3600_000)
    return rows[i:j] if j > i else None

def drift(coin, t0, px0, sgn, hours):
    w = window(coin, t0, hours)
    if not w or not px0: return None
    end = w[-1][4]
    hi = max(b[2] for b in w); lo = min(b[3] for b in w)
    best = hi if sgn > 0 else lo
    worst = lo if sgn > 0 else hi
    return dict(
        drift = sgn*(end - px0)/px0*100,
        mfe   = sgn*(best - px0)/px0*100,
        mae   = sgn*(worst - px0)/px0*100,
    )

def cluster_ci(pairs, iters=5000):
    """pairs: (day, value). Бутстрап по ДНЯМ."""
    byday = {}
    for d, v in pairs: byday.setdefault(d, []).append(v)
    days = list(byday)
    if len(days) < 3: return (float('nan'),)*2
    out = []
    for _ in range(iters):
        vals = []
        for _ in range(len(days)):
            vals += byday[random.choice(days)]
        out.append(sum(vals)/len(vals))
    out.sort()
    return out[int(.025*len(out))], out[int(.975*len(out))]

def fmt(x): return f'{x:+.3f}'

def report(rows, title, hours):
    if len(rows) < 20:
        print(f'  {title}: n={len(rows)} — мало, не считаю'); return
    d = [r['d']['drift'] for r in rows]
    pairs = [(r['day'], r['d']['drift']) for r in rows]
    lo, hi = cluster_ci(pairs)
    bp = [(r['day'], r['d']['drift'] - r['base']) for r in rows]
    blo, bhi = cluster_ci(bp)
    excess = st.mean(x for _, x in bp)
    pos = sum(1 for x in d if x > 0)/len(d)*100
    print(f'  {title:22s} n={len(rows):4d}  drift {fmt(st.mean(d))}%  медиана {fmt(st.median(d))}%  '
          f'CI[{fmt(lo)},{fmt(hi)}]  вверх {pos:.0f}%')
    print(f'  {"":22s}          сверх случайного момента {fmt(excess)}пп  CI[{fmt(blo)},{fmt(bhi)}]'
          f'{"  ← значимо" if blo*bhi > 0 else ""}')
    mfe = [r['d']['mfe'] for r in rows]; mae = [r['d']['mae'] for r in rows]
    print(f'  {"":22s}          лучшее в окне {fmt(st.median(mfe))}%  худшее {fmt(st.median(mae))}% (медианы)')

for H in HORIZONS:
    print(f'\n═══ горизонт {H}ч после выхода ({INTERVAL} свечи) ═══')
    rows = []
    for r in rts:
        sgn = 1 if r['side'] == 'long' else -1
        d = drift(r['coin'], r['exit_time'], r['exit_px'], sgn, H)
        if not d: continue
        # бейзлайн: те же монета/сторона/горизонт, случайные моменты
        cd = C[r['coin']]; ts = cd[1]
        bs = []
        for _ in range(K_BASE):
            t = random.choice(ts)
            row = cd[0][bisect_left(ts, t)]
            b = drift(r['coin'], t, row[4], sgn, H)
            if b: bs.append(b['drift'])
        if len(bs) < K_BASE//2: continue
        gross = sgn*(r['exit_px'] - r['entry_px'])/r['entry_px']*100
        rows.append(dict(r=r, d=d, base=st.mean(bs), gross=gross,
                         day=datetime.fromtimestamp(r['exit_time']/1000, timezone.utc).strftime('%Y-%m-%d')))
    report(rows, 'ВСЕ сделки', H)
    report([x for x in rows if x['gross'] > 0], 'закрытые в плюс', H)
    report([x for x in rows if x['gross'] <= 0], 'закрытые в минус', H)
    report([x for x in rows if x['r']['src'] == 'manual_entry'], 'ручной вход', H)
    report([x for x in rows if x['r']['closed_by_bot']], 'выход закрыл бот', H)
    report([x for x in rows if not x['r']['closed_by_bot']], 'выход закрыл я', H)
    report([x for x in rows if x['r']['side'] == 'long'], 'лонги', H)
    report([x for x in rows if x['r']['side'] == 'short'], 'шорты', H)
