#!/usr/bin/env python3
"""Neutral judge: same captures + metrics for each place.
usage: judge.py <arm a|b> map|ui|perf|all   (only that arm's place open in Studio)"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import rs

HERE = os.path.dirname(os.path.abspath(__file__))
arm, what = sys.argv[1], sys.argv[2]
PLACE = {'a': 'BakeoffA', 'b': 'BakeoffB'}[arm]
OUT = os.path.join(HERE, 'out', arm)
os.makedirs(OUT, exist_ok=True)
rs.ensure_server()
IID = rs.instance(PLACE)
log = open(os.path.join(OUT, 'judge.log'), 'a')

def call(tool, **a):
    a.setdefault('instance_id', IID)
    r = rs.call(tool, a)
    log.write(f'--- {tool} {json.dumps({k: v for k, v in a.items() if k != "code"})[:300]}\n{rs.text_of(r)[:3000]}\n')
    log.flush()
    return r

def luau(code, target=None):
    a = {'code': code}
    if target: a['target'] = target
    r = call('execute_luau', **a)
    return rs.text_of(r)

def save_imgs(r, name):
    imgs = rs.images_of(r)
    paths = []
    for k, b in enumerate(imgs):
        p = os.path.join(OUT, f'{name}{"" if len(imgs) == 1 else "-" + str(k)}.jpg')
        open(p, 'wb').write(b)
        paths.append(p)
    if not imgs: print('no image for', name, rs.text_of(r)[:300])
    return paths

def parse_json(t):
    i, j = t.find('{'), t.rfind('}')
    if i < 0: return {'raw': t[:500]}
    try: d = json.loads(t[i:j + 1])
    except Exception: return {'raw': t[:1500]}
    rv = (d.get('returnValue') or d.get('result')) if isinstance(d, dict) else None
    if isinstance(rv, str) and rv.startswith('{'): return json.loads(rv)
    if isinstance(rv, dict): return rv
    return d

def rv_text(t):
    try:
        d = json.loads(t[t.find('{'):t.rfind('}') + 1]); v = d.get('returnValue')
        return v if isinstance(v, str) else json.dumps(v)
    except Exception: return t

def restore_window():
    import subprocess
    ps = ('Add-Type @"\nusing System; using System.Runtime.InteropServices;\npublic class W { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); }\n"@\n'
          f'Get-Process RobloxStudioBeta | Where-Object {{ $_.MainWindowTitle -like "*{PLACE}*" }} | ForEach-Object {{ if ([W]::IsIconic($_.MainWindowHandle)) {{ [W]::ShowWindow($_.MainWindowHandle, 9) | Out-Null; "restored" }} else {{ "ok" }} }}')
    r = subprocess.run(['powershell.exe', '-NoProfile', '-Command', ps], capture_output=True, text=True)
    log.write(f'--- restore_window {r.stdout.strip()} {r.stderr.strip()[:200]}\n')

def play(action):
    return call('solo_playtest', action=action, **({'mode': 'play', 'timeout': 90} if action == 'start' else {}))

def stop_play():
    play('stop'); time.sleep(3)

def map_task():
    st = rs.text_of(call('solo_playtest', action='status'))
    if '"running":true' in st.replace(' ', ''): stop_play()
    m = parse_json(luau(open(os.path.join(HERE, 'map_metrics.luau')).read()))
    json.dump(m, open(os.path.join(OUT, 'map_metrics.json'), 'w'), indent=1)
    if 'bbox' not in m: print(m); return
    call('set_device_simulator', target='edit', deviceId='hd_720')
    (x0, y0, z0), (x1, y1, z1) = m['playBbox']['min'], m['playBbox']['max']  # reachable area
    cx, cz, gy = (x0 + x1) / 2, (z0 + z1) / 2, m['groundY']
    R = max(x1 - x0, z1 - z0)
    spots = luau('''local m=workspace.FarmTown local s for _,d in m:GetDescendants() do if d:IsA("SpawnLocation") then s=d break end end
local b=m:FindFirstChild("BossSpawn") local function f(p) return p and string.format("%.1f,%.1f,%.1f",p.Position.X,p.Position.Y,p.Position.Z) or "" end
return f(s).."|"..f(b)''')
    spots = rv_text(spots).split('|')
    def v(s):
        try: return [float(t) for t in s.split(',')]
        except Exception: return None
    sp, bp = v(spots[0]) if spots else None, v(spots[1]) if len(spots) > 1 else None
    cams = []
    for k, (sx, sz) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
        cams.append((f'map-oblique{k + 1}', [cx + sx * 0.42 * R, gy + 0.2 * R, cz + sz * 0.42 * R], [cx, gy, cz]))
    if sp: cams.append(('map-eye-spawn', [sp[0], sp[1] + 6, sp[2]], [cx, gy + 4, cz]))
    if bp: cams.append(('map-eye-boss', [bp[0], gy + 6, bp[2]], [cx, gy + 4, cz]))
    cams.append(('map-top', [cx, gy + 0.8 * R, cz + 0.01], [cx, gy, cz]))
    for name, pos, look in cams:
        luau(f'local c=workspace.CurrentCamera c.CameraType=Enum.CameraType.Scriptable c.CFrame=CFrame.lookAt(Vector3.new({pos[0]},{pos[1]},{pos[2]}),Vector3.new({look[0]},{look[1]},{look[2]})) c.FieldOfView=70')
        time.sleep(2.5)
        restore_window()
        save_imgs(call('capture_screenshot', format='jpeg', quality=90), name)
    call('set_device_simulator', target='edit', stopSimulation=True)
    # play: default camera at spawn
    play('start'); time.sleep(10)
    call('set_device_simulator', target='client-1', deviceId='hd_720')
    time.sleep(2)
    restore_window()
    save_imgs(call('capture_screenshot', format='jpeg', quality=90), 'map-play-spawn')
    logs = rs.text_of(call('get_runtime_logs', tail=200))
    open(os.path.join(OUT, 'map_play_logs.txt'), 'w').write(logs)
    stop_play()

PERF_SERVER = r'''
local Players = game:GetService("Players")
local RS = game:GetService("RunService")
local m = workspace:FindFirstChild("FarmTown")
local pts = {}
if m and m:FindFirstChild("DogSpawns") then for _, d in m.DogSpawns:GetChildren() do table.insert(pts, d.Position) end end
for _, d in (m and m:GetDescendants() or {}) do if d:IsA("SpawnLocation") then table.insert(pts, d.Position) end end
if #pts == 0 then table.insert(pts, Vector3.new(0, 5, 0)) end
local folder = Instance.new("Folder") folder.Name = "__JudgeDummies" folder.Parent = workspace
local desc = Instance.new("HumanoidDescription")
local dummies = {}
for i = 1, 40 do
  local c = Players:CreateHumanoidModelFromDescription(desc, Enum.HumanoidRigType.R15)
  c.Name = "Dummy" .. i
  c:PivotTo(CFrame.new(pts[(i % #pts) + 1] + Vector3.new(math.random(-6, 6), 4, math.random(-6, 6))))
  c.Parent = folder
  table.insert(dummies, c)
end
local alive = true
task.spawn(function()
  while alive do
    for _, c in dummies do
      local h = c:FindFirstChildOfClass("Humanoid")
      if h then h:MoveTo(pts[math.random(1, #pts)] + Vector3.new(math.random(-20, 20), 0, math.random(-20, 20))) end
    end
    task.wait(3)
  end
end)
task.wait(4)
local t, n, worst = 0, 0, 0
local conn = RS.Heartbeat:Connect(function(dt) t += dt n += 1 worst = math.max(worst, dt) end)
task.wait(10)
conn:Disconnect()
local stuckFell = 0
for _, c in dummies do local r = c:FindFirstChild("HumanoidRootPart") if not r or r.Position.Y < -50 then stuckFell += 1 end end
alive = false
return game:GetService("HttpService"):JSONEncode({ heartbeatAvgMs = t / n * 1000, heartbeatWorstMs = worst * 1000, frames = n, dummiesLostOrFell = stuckFell })
'''
PERF_CLIENT = r'''
local RS = game:GetService("RunService")
local t, n, worst = 0, 0, 0
local conn = RS.RenderStepped:Connect(function(dt) t += dt n += 1 worst = math.max(worst, dt) end)
task.wait(8)
conn:Disconnect()
return game:GetService("HttpService"):JSONEncode({ renderAvgMs = t / n * 1000, renderWorstMs = worst * 1000, frames = n,
  memMb = game:GetService("Stats"):GetTotalMemoryUsageMb() })
'''

def perf_task():
    import threading
    play('start'); time.sleep(10)
    res = {}
    def srv(): res['server'] = parse_json(rs.text_of(call('eval_server_runtime', code=PERF_SERVER)))
    th = threading.Thread(target=srv); th.start()
    time.sleep(6)
    res['client'] = parse_json(rs.text_of(call('eval_client_runtime', code=PERF_CLIENT)))
    th.join()
    res['scene'] = rs.text_of(call('get_scene_analysis', mode='triangle_composition', target='client-1', topN=10))[:6000]
    json.dump(res, open(os.path.join(OUT, 'perf.json'), 'w'), indent=1)
    stop_play()

BACKDROP = r'''
local cam = workspace.CurrentCamera
cam.CameraType = Enum.CameraType.Scriptable
cam.CFrame = CFrame.new(0, 5000, 0)
local p = Instance.new("Part") p.Name = "__JudgeBackdrop" p.Anchored = true p.CanCollide = false
p.Size = Vector3.new(4000, 4000, 1) p.Color = Color3.fromRGB(120, 128, 138) p.Material = Enum.Material.SmoothPlastic
p.CFrame = cam.CFrame * CFrame.new(0, 0, -200) p.Parent = workspace
local L = game:GetService("Lighting") L.ClockTime = 14 L.Brightness = 2
for _, e in L:GetChildren() do if e:IsA("PostEffect") or e:IsA("Atmosphere") then e.Parent = nil end end
return "ok"
'''

def ui_task():
    play('start'); time.sleep(12)
    devs = rs.text_of(call('get_device_simulator_state', target='client-1', includeDeviceList=True))
    open(os.path.join(OUT, 'devices.txt'), 'w').write(devs)
    print(rs.text_of(call('eval_client_runtime', code=BACKDROP)))
    sizes = [('phone-portrait', 'iphone_14', 'Portrait'), ('phone-landscape', 'iphone_14', 'LandscapeLeft'),
             ('tablet', 'ipad_6th_generation', 'LandscapeLeft'), ('desktop-1080p', 'hd_1080', None)]
    states = [
        ('hud', 'local U=require(game.ReplicatedStorage:WaitForChild("BakeoffUI",10)) U.setDemo(700,2) U.close() return "ok"'),
        ('shop', 'local U=require(game.ReplicatedStorage.BakeoffUI) U.setDemo(700,2) U.open("Shop") return "ok"'),
        ('confirm', 'local U=require(game.ReplicatedStorage.BakeoffUI) U.confirm("Uzi") return "ok"'),
        ('shop-broke', 'local U=require(game.ReplicatedStorage.BakeoffUI) U.close() U.setDemo(100,2) U.open("Shop") return "ok"'),
        ('inventory', 'local U=require(game.ReplicatedStorage.BakeoffUI) U.setDemo(700,2) U.open("Inventory") return "ok"'),
        ('robux', 'local U=require(game.ReplicatedStorage.BakeoffUI) U.open("Robux") return "ok"'),
    ]
    metrics = {}
    ui_src = open(os.path.join(HERE, 'ui_metrics.luau')).read()
    for sname, code in states:
        metrics[sname] = {}
        for dname, dev, orient in sizes:
            call('set_device_simulator', target='client-1', deviceId=dev, **({'orientation': orient} if orient else {}))
            time.sleep(1.0)
            r = rs.text_of(call('eval_client_runtime', code=code))
            time.sleep(1.2)
            restore_window()
            save_imgs(call('capture_screenshot', format='jpeg', quality=92), f'ui-{sname}-{dname}')
            mt = parse_json(rs.text_of(call('eval_client_runtime', code=ui_src)))
            mt['stateCall'] = r[:200]
            metrics[sname][dname] = mt
    json.dump(metrics, open(os.path.join(OUT, 'ui_metrics.json'), 'w'), indent=1)
    open(os.path.join(OUT, 'ui_play_logs.txt'), 'w').write(rs.text_of(call('get_runtime_logs', tail=300)))
    stop_play()

if what in ('map', 'all'): map_task()
if what in ('perf', 'all'): perf_task()
if what in ('ui', 'all'): ui_task()
print('done', OUT)
