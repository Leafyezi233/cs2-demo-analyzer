import os, json, sys
from pathlib import Path
BASE = Path(__file__).resolve().parent
os.environ.setdefault('AWPY_DATA_DIR', str(BASE / 'mapdata'))
import awpy.data as ad
print('data_dir', ad.data_dir())
print('exists', Path(ad.data_dir()).exists())
t = ad.map_data()
print('maps in map_data:', len(t))
d = t.get('de_mirage')
print('de_mirage keys:', sorted(d.keys()) if isinstance(d, dict) else type(d))
print('de_mirage:', json.dumps(d, ensure_ascii=False)[:400])
try:
    print('radar_path', ad.radar_path('de_mirage'))
    print('radar exists', Path(ad.radar_path('de_mirage')).is_file())
except Exception as e:
    print('radar ERR', type(e).__name__, e)
try:
    print('mesh_path', ad.mesh_path('de_mirage'))
except Exception as e:
    print('mesh ERR', e)
try:
    print('nav_path', ad.nav_path('de_mirage'))
except Exception as e:
    print('nav ERR', e)