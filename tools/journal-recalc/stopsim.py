import json, random, statistics as st
from datetime import datetime, timezone

d = json.load(open('ha.json'))
A = [t for t in d if t.get('strategy_id') == 'adopt' and t.get('mode') == 'PRODUCTION']

def pnl_pct(t):
    e, c = t.get('entry_price'), t.get('close_price')
    if not e or not c: return None
    r = (c - e) / e * 100
    return r if t['side'] == 'long' else -r

# usable rows: need mae_pct and a computable realized %
rows = []
for t in A:
    p = pnl_pct(t)
    if p is None or t.get('mae_pct') is None: continue
    rows.append((t, p, t['mae_pct'], t.get('mfe_pct')))

print(f'adopt/PROD total={len(A)}  usable (mae_pct + prices)={len(rows)}')
mae_missing = len([t for t in A if t.get('mae_pct') is None])
print(f'missing mae_pct: {mae_missing}')

# sanity: does mae sign convention hold? mae should be <= 0
maes = [r[2] for r in rows]
print(f'mae range: {min(maes):.2f} .. {max(maes):.2f}   (expect <=0)')
mfes = [r[3] for r in rows if r[3] is not None]
print(f'mfe range: {min(mfes):.2f} .. {max(mfes):.2f}   (expect >=0)')

FEE_PCT = 0.09  # round-trip taker fee approx, HL ~0.045% per side

def sim(stop_pct, rws):
    """If drawdown reached stop level, trade closes at -stop. Else keeps actual result."""
    out = []
    stopped = 0
    saved_winners = 0
    for t, p, mae, mfe in rws:
        if mae <= -stop_pct:
            out.append(-stop_pct - FEE_PCT)
            stopped += 1
            if p > 0: saved_winners += 1
        else:
            out.append(p - FEE_PCT)
    n = len(out)
    return dict(stop=stop_pct, n=n, net=sum(out), exp=sum(out)/n,
                wr=100*len([x for x in out if x > 0])/n,
                stopped=stopped, killed_winners=saved_winners,
                med=st.median(out))

print('\n' + '='*104)
print('STOP SIMULATION (all adopt/PROD, results in % per trade, incl ~0.09% round-trip fee)')
print('="hard stop at X%; a trade is stopped iff its actual MAE reached X%"')
print('='*104)
print(f'{"stop":>6}{"n":>5}{"net%":>9}{"exp%":>8}{"med%":>8}{"WR":>7}{"stopped":>9}{"of them winners":>17}')
base = None
for s in (0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 99.0):
    r = sim(s, rows)
    if s == 99.0: base = r
    lbl = 'none' if s == 99.0 else f'{s:.2f}%'
    print(f'{lbl:>6}{r["n"]:>5}{r["net"]:>9.1f}{r["exp"]:>8.3f}{r["med"]:>8.3f}{r["wr"]:>6.1f}%{r["stopped"]:>9}{r["killed_winners"]:>17}')

print('\nbaseline (no added stop) exp = %.3f%%/trade' % base['exp'])

# bootstrap CI for the best few
def boot(vals, iters=20000):
    n=len(vals); ms=[]
    for _ in range(iters): ms.append(sum(random.choices(vals,k=n))/n)
    ms.sort(); return ms[int(.025*iters)], ms[int(.975*iters)]

def sim_vals(stop_pct, rws):
    out=[]
    for t,p,mae,mfe in rws:
        out.append(-stop_pct-FEE_PCT if mae<=-stop_pct else p-FEE_PCT)
    return out

random.seed(7)
print('\n' + '='*104)
print('BOOTSTRAP 95% CI on exp% per trade')
print('='*104)
for s in (1.0, 1.5, 2.0, 99.0):
    v = sim_vals(s, rows)
    lo, hi = boot(v)
    lbl = 'no stop' if s == 99 else f'stop {s}%'
    print(f'{lbl:<12} exp={sum(v)/len(v):+.3f}%  CI [{lo:+.3f}, {hi:+.3f}]  {"** > 0" if lo>0 else ""}')

# does it survive removing the 4 lucky coins?
TOP4={'MANTA','XPL','POPCAT','RESOLV'}; BAN4={'HMSTR','KAITO','AERO','JTO'}
print('\n' + '='*104)
print('SAME STOP, TAILS REMOVED (the test that killed the coin thesis)')
print('='*104)
subsets = [('all', rows),
           ('minus TOP4', [r for r in rows if r[0]['coin'] not in TOP4]),
           ('body (no tails)', [r for r in rows if r[0]['coin'] not in TOP4|BAN4])]
print(f'{"subset":<18}{"n":>5}{"no-stop exp%":>14}{"stop1.5% exp%":>15}{"CI(stop1.5)":>26}')
for name, rws in subsets:
    if not rws: continue
    v0 = sim_vals(99, rws); v1 = sim_vals(1.5, rws)
    lo, hi = boot(v1)
    print(f'{name:<18}{len(rws):>5}{sum(v0)/len(v0):>14.3f}{sum(v1)/len(v1):>15.3f}   [{lo:+.3f}, {hi:+.3f}]{"  **" if lo>0 else ""}')

# how much of the current loss is just the fat left tail
print('\n' + '='*104)
print('WHERE THE MONEY LEAKS: distribution of actual % results')
print('='*104)
ps = sorted(p for _, p, _, _ in rows)
print(f'n={len(ps)}  median={st.median(ps):+.2f}%  mean={st.mean(ps):+.2f}%')
for q in (1, 5, 10, 25, 50, 75, 90, 95, 99):
    print(f'  p{q:<3} = {ps[int(q/100*(len(ps)-1))]:+7.2f}%')
worst = ps[:15]
print(f'  15 worst trades sum = {sum(worst):+.1f}%  (mean {st.mean(worst):+.2f}%)')
print(f'  net without them     = {sum(ps[15:]):+.1f}% over {len(ps)-15} trades')

# MFE reality check: what did winners vs losers look like
print('\n' + '='*104)
print('MFE/MAE REALITY CHECK (is the entry any good?)')
print('='*104)
w = [(p, mae, mfe) for _, p, mae, mfe in rows if p > 0 and mfe is not None]
l = [(p, mae, mfe) for _, p, mae, mfe in rows if p <= 0 and mfe is not None]
print(f'winners n={len(w)}: mean MFE={st.mean([x[2] for x in w]):+.2f}%  mean MAE={st.mean([x[1] for x in w]):+.2f}%')
print(f'losers  n={len(l)}: mean MFE={st.mean([x[2] for x in l]):+.2f}%  mean MAE={st.mean([x[1] for x in l]):+.2f}%')
print(f'ALL     n={len(rows)}: mean MFE={st.mean([x[3] for x in rows if x[3] is not None]):+.2f}%  mean MAE={st.mean(maes):+.2f}%')
sym = [x for x in rows if x[3] is not None]
better = len([1 for _, p, mae, mfe in sym if mfe > -mae])
print(f'trades where peak > drawdown: {better}/{len(sym)} = {100*better/len(sym):.0f}%  (coin-flip entry ~50%)')
lo, hi = boot([1.0 if mfe > -mae else 0.0 for _, p, mae, mfe in sym])
print(f'  95% CI on that share: [{100*lo:.0f}%, {100*hi:.0f}%]  -> {"edge in entry" if lo>0.5 else "NOT distinguishable from coin flip"}')
