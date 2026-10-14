import struct, os
from pathlib import Path
BASE = Path(__file__).resolve().parent
p = BASE / 'mapdata' / '2000930' / 'radars' / 'de_mirage.png'
b = p.read_bytes()[:32]
w, h = struct.unpack('>II', b[16:24])
print('png', w, h, 'bytes', p.stat().st_size)
d = BASE / 'mapdata' / '2000930'
print(sorted(x.name for x in (d/'radars').iterdir())[:25])