import sys, json
mods = {}
for m in ['polars','fastapi','uvicorn','pydantic','starlette','awpy','typer','click']:
    try:
        mod = __import__(m)
        mods[m] = getattr(mod, '__version__', '?')
    except Exception as e:
        mods[m] = 'ERR:' + type(e).__name__
print(json.dumps({'version': sys.version, 'prefix': sys.prefix, 'executable': sys.executable, 'mods': mods}, ensure_ascii=False))