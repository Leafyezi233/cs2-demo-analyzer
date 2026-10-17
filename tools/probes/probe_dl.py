import sys, os, time
import awpy.data as ad
t=time.time()
try:
    r = ad.update()
    print('update() ->', r)
except Exception as e:
    print('update FAILED:', type(e).__name__, str(e)[:500])
print('elapsed %.1fs' % (time.time()-t))
p=str(ad.data_dir()); print('data_dir', p, 'exists', os.path.isdir(p))
if os.path.isdir(p):
    for root,dirs,files in os.walk(p):
        lvl=os.path.relpath(root,p).count(os.sep)
        if lvl<=1: print(' ', os.path.relpath(root,p), '| dirs=',dirs[:10],'| nfiles=',len(files))