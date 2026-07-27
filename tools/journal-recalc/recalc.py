import json, random, statistics as st
from datetime import datetime, timezone

d = json.load(open('ha.json'))
adopt = [t for t in d if t.get('strategy_id') == 'adopt' and t.get('mode') == 'PRODUCTION']

def dt(ms): return datetime.fromtimestamp(ms/1000, timezone.utc)

# reproduce original window 12.06 -> 15.07
W_END = datetime(2026, 7, 16, tzinfo=timezone.utc)
orig = [t for t in adopt if dt(t['closed_at']) < W_END]
full = adopt

TOP4 = {'MANTA', 'XPL', 'POPCAT', 'RESOLV'}
BAN4 = {'HMSTR', 'KAITO', 'AERO', 'JTO'}

def pnl(t): return t.get('realized_pnl') or 0.0

def stats(rows, label):
    if not rows:
        print(f'{label:<38} n=0'); return
    p = [pnl(t) for t in rows]
    n = len(p); s = sum(p)
    wins = [x for x in p if x > 0]; losses = [x for x in p if x <= 0]
    wr = 100*len(wins)/n
    exp = s/n
    med = st.median(p)
    aw = st.mean(wins) if wins else 0
    al = st.mean(losses) if losses else 0
    print(f'{label:<38} n={n:<4} WR={wr:5.1f}%  net=${s:8.2f}  exp=${exp:+6.3f}  med=${med:+6.3f}  avgW=${aw:+5.2f} avgL=${al:+5.2f}')

def boot(rows, label, iters=20000):
    p = [pnl(t) for t in rows]
    if len(p) < 5: print(f'{label}: n too small'); return
    n = len(p)
    means = []
    for _ in range(iters):
        means.append(sum(random.choices(p, k=n))/n)
    means.sort()
    lo, hi = means[int(.025*iters)], means[int(.975*iters)]
    print(f'{label:<38} exp=${sum(p)/n:+.3f}  95% CI [{lo:+.3f}, {hi:+.3f}]  {"NE 0" if lo>0 or hi<0 else "includes 0"}')

random.seed(42)
print('='*112)
print(f'ALL adopt/PROD in archive: {len(full)}   |  window 12.06-15.07: {len(orig)}')
print(f'archive last closed_at: {dt(max(t["closed_at"] for t in full)):%Y-%m-%d %H:%M} UTC')
print('='*112)

for tag, rows in (('[window 12.06-15.07]', orig), ('[FULL to 26.07]', full)):
    print(f'\n----- {tag} -----')
    stats(rows, 'all')
    stats([t for t in rows if t['coin'] not in TOP4], 'minus TOP4')
    stats([t for t in rows if t['coin'] not in BAN4], 'minus BAN4')
    stats([t for t in rows if t['coin'] not in TOP4 | BAN4], 'minus BOTH tails (body)')
    print()
    sh = [t for t in rows if t['side'] == 'short']
    stats(sh, 'SHORT all')
    stats([t for t in sh if t['coin'] not in TOP4], 'SHORT minus TOP4')
    stats([t for t in sh if t['coin'] not in TOP4 | BAN4], 'SHORT body')

print('\n' + '='*112)
print('THE QUESTION: hold <15min, with and without TOP4   [window]')
print('='*112)

def hold_s(t):
    h = t.get('hold_seconds')
    if h: return h
    if t.get('entry_time') and t.get('closed_at'): return (t['closed_at']-t['entry_time'])/1000
    return None

for tag, rows in (('window', orig), ('full', full)):
    fast = [t for t in rows if (hold_s(t) or 1e9) < 900]
    print(f'\n--- {tag} ---')
    stats(fast, '<15min all')
    stats([t for t in fast if t['coin'] not in TOP4], '<15min minus TOP4')
    stats([t for t in fast if t['coin'] not in TOP4 | BAN4], '<15min body (no tails)')
    slow = [t for t in rows if 900 <= (hold_s(t) or -1) < 14400]
    stats(slow, '15min-4h all')
    stats([t for t in slow if t['coin'] not in TOP4 | BAN4], '15min-4h body')

print('\n' + '='*112)
print('BOOTSTRAP 95% CI on expectancy [window]')
print('='*112)
boot(orig, 'all')
boot([t for t in orig if t['coin'] not in TOP4 | BAN4], 'body (no tails)')
boot([t for t in orig if t['side']=='short'], 'SHORT all')
boot([t for t in orig if t['side']=='short' and t['coin'] not in TOP4|BAN4], 'SHORT body')
fast = [t for t in orig if (hold_s(t) or 1e9) < 900]
boot(fast, '<15min all')
boot([t for t in fast if t['coin'] not in TOP4], '<15min minus TOP4')
boot([t for t in fast if t['coin'] not in TOP4|BAN4], '<15min body')

print('\n' + '='*112)
print('OVERLAP: how much of <15min profit IS top4?  [window]')
print('='*112)
f_top = [t for t in fast if t['coin'] in TOP4]
print(f'<15min total n={len(fast)} net=${sum(pnl(t) for t in fast):.2f}')
print(f'  of which TOP4: n={len(f_top)} net=${sum(pnl(t) for t in f_top):.2f}  '
      f'({100*len(f_top)/len(fast):.0f}% of trades)')

print('\n' + '='*112)
print('PER-COIN [window], sorted by net')
print('='*112)
coins = {}
for t in orig: coins.setdefault(t['coin'], []).append(t)
rank = sorted(coins.items(), key=lambda kv: -sum(pnl(x) for x in kv[1]))
print(f'{"coin":<10}{"n":>4}{"net":>9}{"exp":>8}{"WR":>7}')
for c, rows in rank:
    if len(rows) < 3: continue
    p = [pnl(x) for x in rows]
    print(f'{c:<10}{len(rows):>4}{sum(p):>9.2f}{sum(p)/len(p):>8.2f}{100*len([x for x in p if x>0])/len(p):>6.0f}%')

# concentration
allp = sorted((pnl(t) for t in orig), reverse=True)
print(f'\nCONCENTRATION [window]: total ${sum(allp):.2f}')
for k in (1, 3, 5, 10):
    print(f'  top {k:>2} trades = ${sum(allp[:k]):+7.2f}   bottom {k:>2} = ${sum(allp[-k:]):+7.2f}')
print(f'  net without top10 AND bottom10 = ${sum(allp[10:-10]):+.2f} over {len(allp)-20} trades')
