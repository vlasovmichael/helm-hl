import json
from collections import defaultdict, Counter

fills = [json.loads(l) for l in open('fills.jsonl')]
fills.sort(key=lambda r: (r['coin'], r['time'], r['tid']))
bot = {x['oid']: x['kind'] for x in json.load(open('bot_oids.json'))}

by = defaultdict(list)
for f in fills: by[f['coin']].append(f)

rts = []
for coin, rows in by.items():
    pos = 0.0; ent_sz = 0.0; ent_not = 0.0
    ex_sz = 0.0; ex_not = 0.0
    entry_t = None; open_oids = set(); close_oids = set()
    pnl = 0.0; fee = 0.0
    for f in rows:
        sz = float(f['sz']); px = float(f['px'])
        signed = sz if f['side'] == 'B' else -sz
        prev = pos
        if prev == 0 or (prev > 0) == (signed > 0):
            add, red = abs(signed), 0.0
        else:
            red = min(abs(signed), abs(prev)); add = abs(signed) - red
        if red > 0:
            ex_sz += red; ex_not += red*px; close_oids.add(f['oid'])
        pnl += float(f.get('closedPnl') or 0)
        fee += float(f.get('fee') or 0) + float(f.get('builderFee') or 0)
        pos = prev + signed
        if abs(pos) < 1e-12: pos = 0.0
        if red > 0 and pos == 0:
            side = 'long' if prev > 0 else 'short'
            epx = ent_not/ent_sz if ent_sz else None
            xpx = ex_not/ex_sz if ex_sz else px
            src = 'bot' if any(bot.get(o) == 'open' for o in open_oids) else 'manual_entry'
            closed_by_bot = any(bot.get(o) in ('close','sl_trigger','tp_trigger') for o in close_oids)
            rts.append(dict(coin=coin, side=side, entry_time=entry_t, exit_time=f['time'],
                            entry_px=epx, exit_px=xpx, notional=ent_not, pnl=pnl, fee=fee,
                            src=src, closed_by_bot=closed_by_bot,
                            hold_min=(f['time']-entry_t)/60000 if entry_t else None))
            pos = 0.0; ent_sz=ent_not=ex_sz=ex_not=0.0; entry_t=None
            open_oids=set(); close_oids=set(); pnl=0.0; fee=0.0
        if add > 0:
            if entry_t is None: entry_t = f['time']
            ent_sz += add; ent_not += add*px; open_oids.add(f['oid'])

rts = [r for r in rts if r['entry_px'] and r['entry_time']]
rts.sort(key=lambda r: r['exit_time'])
json.dump(rts, open('rts.json','w'))
print('round-trips:', len(rts))
print('источник входа:', Counter(r['src'] for r in rts).most_common())
print('выход закрыл бот:', Counter(r['closed_by_bot'] for r in rts).most_common())
print('стороны:', Counter(r['side'] for r in rts).most_common())
net = sum(r['pnl']-r['fee'] for r in rts)
print(f'нетто по всем: ${net:.2f}   комиссий ${sum(r["fee"] for r in rts):.2f}')
import statistics as st
pcts=[]
for r in rts:
    sgn = 1 if r['side']=='long' else -1
    pcts.append(sgn*(r['exit_px']-r['entry_px'])/r['entry_px']*100)
print(f'средний gross ход: {st.mean(pcts):+.3f}%  медиана {st.median(pcts):+.3f}%')
