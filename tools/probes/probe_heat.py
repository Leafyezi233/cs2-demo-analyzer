import json, urllib.request, statistics
def get(u):
    with urllib.request.urlopen(u, timeout=30) as f: return json.loads(f.read().decode('utf-8'))
mid='20fb410af53645f6'
info=get('http://127.0.0.1:8765/api/maps/de_mirage/info')
for kind in ('kills','shots'):
    d=get(f'http://127.0.0.1:8765/api/matches/{mid}/heatmap?type={kind}')
    px=[( (p['x']-info['offset_x'])/info['scale'], (info['offset_y']-p['y'])/info['scale']) for p in d['points']]
    xs=[a for a,b in px]; ys=[b for a,b in px]
    print(kind, len(px), 'x', round(min(xs),1), round(max(xs),1), 'y', round(min(ys),1), round(max(ys),1), 'mean', round(statistics.mean(xs),1), round(statistics.mean(ys),1))
    print('   w sample', d['points'][0].get('w'), 'keys', sorted(d['points'][0].keys()))