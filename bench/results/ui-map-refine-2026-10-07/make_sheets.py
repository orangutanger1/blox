#!/usr/bin/env python3
"""Blind sheets. usage: make_sheets.py  (coin flip stored in out/blind.json, never printed)"""
import json, os, random, glob
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
# PAIR=b-r2,c-r2 SHEETS=r2: compare two capture dirs, sheets + key in out/<SHEETS>
P1, P2 = os.environ.get('PAIR', 'a,b').split(',')
OUT = os.path.join(HERE, 'out', os.environ['SHEETS']) if os.environ.get('SHEETS') else os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
ARMS = os.path.join(HERE, 'out')
key = os.path.join(OUT, 'blind.json')
if not os.path.exists(key):
    flip = random.SystemRandom().random() < 0.5
    json.dump({'X': P1 if flip else P2, 'Y': P2 if flip else P1}, open(key, 'w'))
K = json.load(open(key))
try:
    FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    SMALL = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
except Exception:
    FONT = SMALL = ImageFont.load_default()

def cell(path, w, h):
    im = Image.new('RGB', (w, h), (30, 30, 30))
    if path and os.path.exists(path):
        s = Image.open(path).convert('RGB'); s.thumbnail((w, h)); im.paste(s, ((w - s.width) // 2, (h - s.height) // 2))
    else:
        ImageDraw.Draw(im).text((10, h // 2), 'missing', fill=(200, 80, 80), font=SMALL)
    return im

def grid(rows, cols, w, h, title, out):
    """rows: [(label, [path per col])]"""
    lw, th = 230, 60
    sheet = Image.new('RGB', (lw + len(cols) * (w + 8), th + len(rows) * (h + 8)), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    d.text((10, 14), title, fill='white', font=FONT)
    for c, name in enumerate(cols):
        d.text((lw + c * (w + 8) + w // 2 - 20, 14), name, fill=(255, 220, 90), font=FONT)
    for r, (label, paths) in enumerate(rows):
        y = th + r * (h + 8)
        d.text((10, y + h // 2 - 12), label, fill='white', font=SMALL)
        for c, p in enumerate(paths):
            sheet.paste(cell(p, w, h), (lw + c * (w + 8), y))
    sheet.save(out, quality=90)
    return out

def side(lbl, name):
    return os.path.join(ARMS, K[lbl], name)

made = []
shots = ['map-oblique1', 'map-oblique2', 'map-oblique3', 'map-oblique4', 'map-eye-spawn', 'map-eye-boss', 'map-top', 'map-play-spawn']
made.append(grid([(s.replace('map-', ''), [side('X', s + '.jpg'), side('Y', s + '.jpg')]) for s in shots],
                 ['X', 'Y'], 800, 450, 'Task 1 - Farm Town map (blind)', os.path.join(OUT, 'sheet-map.jpg')))
devs = [('phone-portrait', 260, 562), ('phone-landscape', 562, 260), ('tablet', 480, 360), ('desktop-1080p', 640, 360)]
for st in ['hud', 'shop', 'confirm', 'shop-broke', 'inventory', 'robux']:
    rows = []
    cols = []
    for lbl in ['X', 'Y']:
        for dn, _, _ in devs:
            cols.append(f'{lbl}')
    # one row per side, devices across
    lw = 0
    W = sum(w for _, w, _ in devs) + 8 * len(devs) + 120
    H = 2 * (562 + 50) + 70
    sheet = Image.new('RGB', (W, H), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    d.text((10, 14), f'Task 2 - ZA shop UI, state "{st}" (blind)', fill='white', font=FONT)
    for r, lbl in enumerate(['X', 'Y']):
        y = 70 + r * (562 + 50)
        d.text((20, y + 250), lbl, fill=(255, 220, 90), font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 60) if FONT != SMALL else FONT)
        x = 120
        for dn, w, h in devs:
            d.text((x, y), dn, fill=(180, 180, 180), font=SMALL)
            sheet.paste(cell(side(lbl, f'ui-{st}-{dn}.jpg'), w, h), (x, y + 28))
            x += w + 8
    p = os.path.join(OUT, f'sheet-ui-{st}.jpg')
    sheet.save(p, quality=90)
    made.append(p)
print('\n'.join(made))
