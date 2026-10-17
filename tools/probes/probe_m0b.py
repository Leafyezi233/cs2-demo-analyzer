import sys, os, json, io
from awpy import Demo
import awpy.data as ad
OUT = open(r'D:\dsh工作区1\cs2-demo-analyzer\m0_report.txt','w',encoding='utf-8')
def P(*a): print(*a, file=OUT)
DEMO = r'D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\match730_003831016083200933917_0573296683_401.dem'
d = Demo(DEMO)
P('=== STATS (3 rows, key cols) ===')
cols = ['name','kills','deaths','assists','adr','kast','headshot_pct','opening_kills','opening_deaths','multikill_2k','multikill_3k','clutches_played','clutches_won','clutch_1v1','utility_damage','flash_assists','traded_deaths','rounds_played','headshot_kills']
P(d.stats.select(cols).head(3))
P()
P('=== STATS dtypes ===')
P(d.stats.schema)
P()
P('=== ROUNDS (4 rows) ===')
P(d.rounds.head(4))
P()
P('=== ROUND_ECONOMY (6 rows) ===')
P(d.round_economy.head(6))
P()
P('=== PLAYERS ===')
P(d.players)
P()
P('=== KILLS first row (all cols) ===')
P(d.kills.head(1))
P()
P('=== EVENTS names ===')
try:
    P(d.events.names)
except Exception as e: P('events err', type(e).__name__, e)
P()
import inspect
P('=== snapshots signature ===')
P(inspect.signature(d.snapshots))
P((d.snapshots.__doc__ or '')[:800])
P()
P('=== MAP DATA ===')
P('AWPY_DATA_DIR =', ad.AWPY_DATA_DIR)
P('data_dir() =', ad.data_dir())
p = str(ad.data_dir())
P('exists:', os.path.isdir(p))
if os.path.isdir(p):
    for root,dirs,files in os.walk(p):
        lvl = os.path.relpath(root,p).count(os.sep)
        if lvl<=2: P('  ', os.path.relpath(root,p), '| dirs=', dirs[:8], '| files=', files[:8])
for fn in ['available_maps','latest_version','local_versions','manifest']:
    try: P(fn+'():', getattr(ad,fn)())
    except Exception as e: P(fn+' err:', type(e).__name__, str(e)[:300])
P()
P('=== map_data de_mirage ===')
try:
    md = ad.map_data('de_mirage')
    P(type(md)); P(json.dumps(md, ensure_ascii=False)[:800] if isinstance(md,(dict,list)) else str(md)[:800])
except Exception as e: P('map_data err:', type(e).__name__, str(e)[:400])
P()
P('=== radar_path / mesh_path / nav_path ===')
for fn in ['radar_path','mesh_path','nav_path']:
    try: P(fn+'():', getattr(ad,fn)('de_mirage'))
    except Exception as e: P(fn+' err:', type(e).__name__, str(e)[:300])
OUT.close()
print('done')