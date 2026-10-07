"""Neutral judge client: talks to robloxstudio-mcp's local HTTP bridge (same for both places)."""
import json, os, subprocess, time, urllib.request, base64, socket

PORT = 58741
TOKEN_FILE = os.path.expanduser('~/.robloxstudio-mcp/auth-token')
_proc = None

def _up():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=3) as r:
            return json.load(r)
    except Exception:
        return None

def ensure_server():
    global _proc
    if _up(): return
    _proc = subprocess.Popen(['npx', '-y', '@chrrxs/robloxstudio-mcp@latest'], stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=os.path.expanduser('~/bakeoff/judge'))
    for _ in range(90):
        h = _up()
        if h and h.get('pluginConnected'): return
        time.sleep(1)
    raise RuntimeError('robloxstudio-mcp bridge not connected')

def instance(name_part):
    h = _up()
    for i in h['instances']:
        if name_part in (i.get('placeName') or ''): return i['id']
    raise RuntimeError(f'no instance matching {name_part}: {[i.get("placeName") for i in h["instances"]]}')

def call(tool, args, timeout=600):
    tok = open(TOKEN_FILE).read().strip()
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/mcp/{tool}', data=json.dumps(args).encode(),
                                 headers={'Content-Type': 'application/json', 'X-MCP-Auth': tok}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {'error': e.code, 'body': e.read().decode()[:2000]}

def text_of(res):
    if isinstance(res, dict) and 'content' in res:
        return '\n'.join(c.get('text', '') for c in res['content'] if c.get('type') == 'text')
    return json.dumps(res)

def images_of(res):
    out = []
    def walk(o):
        if isinstance(o, dict):
            if o.get('type') == 'image' and 'data' in o: out.append(base64.b64decode(o['data']))
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(res)
    return out
