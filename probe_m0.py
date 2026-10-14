import json, sys, time, traceback
from awpy import Demo

DEMO = r'D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem'

t0 = time.time()
d = Demo(DEMO)
print('OPEN ok in %.1fs' % (time.time()-t0))
print('path:', d.path)
print('tick_rate:', d.tick_rate)
h = dict(d.header)
for k in sorted(h):
    v = h[k]
    s = str(v)
    if len(s) > 120: s = s[:120] + '...'
    print('HEADER', k, '=', s)
print('AVAILABLE:', d.available_datasets())

# cheap datasets first
for name, fn in [
    ('rounds', lambda: d.rounds),
    ('kills', lambda: d.kills),
    ('damages', lambda: d.damages),
    ('bomb', lambda: d.bomb),
    ('shots', lambda: d.shots),
    ('stats', lambda: d.stats),
    ('round_economy', lambda: d.round_economy),
    ('players', lambda: d.players),
]:
    try:
        t = time.time()
        df = fn()
        print('---', name, 'shape=', df.shape, 'in %.1fs' % (time.time()-t))
        print('    cols:', df.columns)
    except Exception as e:
        print('!!!', name, 'FAILED:', type(e).__name__, e)

print('TOTAL %.1fs' % (time.time()-t0))