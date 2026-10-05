import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import { startPlay, stopPlay } from '../studio/play.js';
import { captureScreenshot, type Screenshot } from '../testing/playtest.js';
import { DEVICES, lintSnapshot, type UiFinding } from '../ui/lint.js';
import { probeDevice } from '../ui/run.js';

// See a GUI pack before judging it. Packs often ship their panels hidden
// (Visible=false, or Size 0 waiting for an open tween), so a summary of
// "40 GUI objects" says nothing about how they look. Preview, in one playtest:
// the server copies each panel (scripts stripped) into ReplicatedStorage — the
// scout quarantine is ServerStorage, which clients can't see — then the client
// shows one panel at a time, alone, centred, made visible and given a size if it
// has none, and screen_capture takes each frame.

export const PREVIEW_FOLDER = '__BloxPreview';
const PREVIEW_GUI = '__BloxPreviewGui';
export const MAX_PANELS = 12;

export interface PanelInfo {
  i: number;
  name: string;
  path: string;
  cls: string;
  size: string;
  visible: boolean;
  descendants: number;
  hidden: number; // descendant GuiObjects with Visible=false
}

export interface PanelShot {
  panel: PanelInfo;
  screenshot: Screenshot | null;
  sized: boolean; // had no size; shown at 60% of the screen
  scaled: number; // < 1 when shrunk to fit the screen
  // The panel as authored, laid out on each phone size (ui lint rules).
  phone?: { device: string; findings: UiFinding[] }[];
  phoneError?: string;
  error?: string;
}

const PHONES = DEVICES.filter((d) => d.kind === 'phone');
const SCALE_NAME = '__BloxPreviewScale';
// Drop the fit-to-screen UIScale so phones see the panel at its real size.
const UNSCALE = `local sg = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${PREVIEW_GUI}")
local u = sg and sg:FindFirstChild("${SCALE_NAME}", true)
if u then u:Destroy() end
return "ok"`;

const RESOLVE = `local function resolve(p)
	local cur = game
	for name in string.gmatch(p, "[^%.]+") do
		if cur == game and name == "game" then continue end
		local nxt = cur:FindFirstChild(name)
		if not nxt and cur == game then
			local ok, svc = pcall(function() return game:GetService(name) end)
			nxt = ok and svc or nil
		end
		if not nxt then error("not found: " .. p, 0) end
		cur = nxt
	end
	return cur
end`;

// Server: list the panels under PATH and stage clones for the client. A panel
// is a GuiObject whose parent is not a GuiObject (a ScreenGui, Folder, Model or
// the pack root) — or, when that is only an invisible wrapper, what it holds:
// the screens and templates a pack is made of. Names are paths from PATH.
export function stagePanelsLuau(path: string, names: string[] = [], max = MAX_PANELS): string {
  return `local HttpService = game:GetService("HttpService")
local RS = game:GetService("ReplicatedStorage")
${RESOLVE}
local root = resolve(${longString(path)})
local WANT = HttpService:JSONDecode(${longString(JSON.stringify(names))})
local MAX = ${Math.max(1, Math.floor(max))}
local want = {}
for _, n in WANT do want[n] = true end
local old = RS:FindFirstChild("${PREVIEW_FOLDER}")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "${PREVIEW_FOLDER}"
local out, total = {}, 0
local function relName(d)
	local names = {}
	while d and d ~= root do
		table.insert(names, 1, d.Name)
		d = d.Parent
	end
	return #names > 0 and table.concat(names, ".") or root.Name
end
local function addPanel(d)
	local rn = relName(d)
	if #WANT > 0 and not (want[d.Name] or want[rn]) then return end
	total += 1
	if #out >= MAX then return end
	local c = d:Clone()
	for _, s in c:GetDescendants() do
		if s:IsA("LuaSourceContainer") then s:Destroy() end
	end
	local hidden, count = 0, 0
	for _, s in c:GetDescendants() do
		if s:IsA("GuiObject") then
			count += 1
			if not s.Visible then hidden += 1 end
		end
	end
	c.Name = "P" .. (#out + 1)
	c.Parent = folder
	table.insert(out, { i = #out + 1, name = rn, path = d:GetFullName(), cls = d.ClassName, size = tostring(d.Size), visible = d.Visible, descendants = count, hidden = hidden })
end
-- Packs wrap their screens in invisible full-screen (or 0-size, waiting for a
-- tween) Frames; showing the wrapper shows only whatever was already open.
-- Descend into such wrappers and show what they hold.
local function isWrapper(d)
	if d.ClassName ~= "Frame" or d.BackgroundTransparency < 0.95 then return false end
	local hasKids = false
	for _, ch in d:GetChildren() do
		if ch:IsA("GuiObject") then hasKids = true break end
	end
	if not hasKids then return false end
	local sz = d.Size
	local full = sz.X.Scale >= 0.9 and sz.Y.Scale >= 0.9
	local zero = sz.X.Scale == 0 and sz.X.Offset == 0 or sz.Y.Scale == 0 and sz.Y.Offset == 0
	return full or zero
end
local function collect(d, depth)
	if depth < 6 and isWrapper(d) then
		for _, ch in d:GetChildren() do
			if ch:IsA("GuiObject") then collect(ch, depth + 1) end
		end
	else
		addPanel(d)
	end
end
local function visit(d)
	if d:IsA("GuiObject") and not (d.Parent and d.Parent:IsA("GuiObject")) then collect(d, 0) end
end
visit(root)
for _, d in root:GetDescendants() do visit(d) end
folder.Parent = RS
return HttpService:JSONEncode({ panels = out, total = total })`;
}

// Client: show panel i alone over a neutral backdrop.
export function showPanelLuau(i: number, showAll: boolean): string {
  return `local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local pg = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
local folder = game:GetService("ReplicatedStorage"):WaitForChild("${PREVIEW_FOLDER}", 10)
if not folder then error("preview panels did not replicate", 0) end
local src = folder:WaitForChild("P${Math.floor(i)}", 10)
if not src then error("panel ${Math.floor(i)} did not replicate", 0) end
for _, g in pg:GetChildren() do
	if g:IsA("ScreenGui") and g.Name ~= "${PREVIEW_GUI}" then g.Enabled = false end
end
local sg = pg:FindFirstChild("${PREVIEW_GUI}")
if not sg then
	sg = Instance.new("ScreenGui")
	sg.Name = "${PREVIEW_GUI}"
	sg.IgnoreGuiInset = true
	sg.ResetOnSpawn = false
	sg.DisplayOrder = 10000
	sg.Parent = pg
end
sg:ClearAllChildren()
local bg = Instance.new("Frame")
bg.Size = UDim2.fromScale(1, 1)
bg.BackgroundColor3 = Color3.fromRGB(70, 74, 82)
bg.BorderSizePixel = 0
bg.Parent = sg
local c = src:Clone()
c.Visible = true
c.AnchorPoint = Vector2.new(0.5, 0.5)
c.Position = UDim2.fromScale(0.5, 0.5)
${showAll ? `for _, d in c:GetDescendants() do
	if d:IsA("GuiObject") then d.Visible = true end
end` : ''}
c.Parent = bg
RunService.RenderStepped:Wait()
RunService.RenderStepped:Wait()
local sized = false
if c.AbsoluteSize.X < 8 or c.AbsoluteSize.Y < 8 then
	c.Size = UDim2.fromScale(0.6, 0.6)
	sized = true
	RunService.RenderStepped:Wait()
end
local vs = bg.AbsoluteSize
local s = math.min(1, 0.9 * vs.X / math.max(1, c.AbsoluteSize.X), 0.9 * vs.Y / math.max(1, c.AbsoluteSize.Y))
if s < 1 then
	local u = Instance.new("UIScale")
	u.Name = "${SCALE_NAME}"
	u.Scale = s
	u.Parent = c
end
RunService.RenderStepped:Wait()
RunService.RenderStepped:Wait()
return HttpService:JSONEncode({ sized = sized, scaled = s })`;
}

export function parsePanels(raw: unknown): { panels: PanelInfo[]; total: number } {
  if (typeof raw !== 'string') throw new Error('preview: the server returned no panel list');
  const j = JSON.parse(raw) as { panels?: unknown; total?: number };
  return { panels: Array.isArray(j.panels) ? (j.panels as PanelInfo[]) : [], total: j.total ?? 0 };
}

export async function runPreview(
  session: StudioSession,
  projectPath: string,
  o: { id: string; path: string; panels?: string[]; showAll?: boolean; max?: number; phone?: boolean },
): Promise<{ total: number; shots: PanelShot[] }> {
  const info = await startPlay(session);
  try {
    const st = await runLuau(session, stagePanelsLuau(o.path, o.panels ?? [], o.max ?? MAX_PANELS), 'server', { chunkName: 'previewStage' });
    if (!st.ok) throw new Error(`preview: could not stage panels from ${o.path}: ${st.error?.message}`);
    const { panels, total } = parsePanels(st.values[0]);
    const shots: PanelShot[] = [];
    for (const p of panels) {
      const r = await runLuau(session, showPanelLuau(p.i, o.showAll === true), 'client', { chunkName: 'previewShow' });
      if (!r.ok) {
        shots.push({ panel: p, screenshot: null, sized: false, scaled: 1, error: r.error?.message });
        continue;
      }
      let shown = { sized: false, scaled: 1 };
      try {
        shown = JSON.parse(String(r.values[0])) as typeof shown;
      } catch {
        // keep defaults
      }
      const shot = await captureScreenshot(session, projectPath, `preview-${o.id}-${p.name}`);
      const ps: PanelShot = { panel: p, screenshot: shot, ...shown, ...(shot ? {} : { error: 'screen_capture returned no image' }) };
      if (o.phone !== false) {
        try {
          await runLuau(session, UNSCALE, 'client', { chunkName: 'previewUnscale' });
          ps.phone = [];
          for (const d of PHONES) ps.phone.push({ device: d.name, findings: lintSnapshot({ device: d, elements: (await probeDevice(session, d)).elements }) });
        } catch (e) {
          ps.phoneError = (e as Error).message;
        }
      }
      shots.push(ps);
    }
    return { total, shots };
  } finally {
    await runLuau(session, `local f = game:GetService("ReplicatedStorage"):FindFirstChild("${PREVIEW_FOLDER}") if f then f:Destroy() end`, 'server').catch(() => undefined);
    if (!info.alreadyRunning) await stopPlay(session).catch(() => false);
  }
}

const short = (path: string) => path.replace(new RegExp(`^${PREVIEW_GUI}\\.Frame\\.P\\d+\\.?`), '') || '(panel)';

export function phoneSummary(s: PanelShot): string | null {
  if (s.phoneError) return `phone check failed: ${s.phoneError}`;
  if (!s.phone) return null;
  const bad = s.phone.filter((p) => p.findings.length);
  if (!bad.length) return 'phone: fits';
  return bad
    .map((p) => {
      const rules = [...new Set(p.findings.map((f) => f.rule))];
      return `${p.device}: ${rules.map((r) => {
        const fs = p.findings.filter((f) => f.rule === r);
        return `${r} ×${fs.length} (${short(fs[0].path)}: ${fs[0].detail})`;
      }).join(', ')}`;
    })
    .join('; ');
}

export function formatPreview(id: string, path: string, r: { total: number; shots: PanelShot[] }): string {
  if (!r.shots.length) return `${id}: no GUI panels under ${path} (a panel = a GuiObject whose parent is a ScreenGui, Folder or the pack root)`;
  const lines = [`${id}: ${r.total} panel(s) under ${path}${r.total > r.shots.length ? `, showing ${r.shots.length}` : ''} — each shown alone, centred, visible:`];
  r.shots.forEach((s, n) => {
    const p = s.panel;
    const flags = [
      !p.visible ? 'was hidden' : '',
      s.sized ? `had no size (${p.size}) — shown at 60% of the screen` : '',
      s.scaled < 1 ? `shrunk ×${s.scaled.toFixed(2)} to fit` : '',
      p.hidden ? `${p.hidden}/${p.descendants} inner element(s) hidden (show_all reveals them)` : '',
    ].filter(Boolean);
    lines.push(`  [${n + 1}] ${p.name} (${p.cls}, ${p.path})${flags.length ? ` — ${flags.join('; ')}` : ''}${s.error ? ` — ERROR ${s.error}` : s.screenshot ? ` → ${s.screenshot.path}` : ''}`);
    const ph = phoneSummary(s);
    if (ph) lines.push(`      ${ph}`);
  });
  if (r.shots.some((s) => s.phone?.some((p) => p.findings.length))) {
    lines.push('Phone problems above exist in the pack as made: budget the fixes (scale sizes + UISizeConstraint, 44px hit areas around small buttons) before choosing it, or pick another pack.');
  }
  lines.push('Build menus by cloning these panels (keep their art; rewire text and buttons), not by restyling BloxUI.');
  return lines.join('\n');
}

// ---- models, maps and sounds (edit mode; no playtest) ----
// A clone of the asset is staged far from the map, framed from two angles and
// captured, then removed; sounds report their length (a 5 s "music" track is a
// sting, not a loop). Packs with GUIs and no parts get the panel preview instead.
export const MODEL_PREVIEW = '__BloxModelPreview';
const STAGE_AT = '0, 3000, -30000';

export function stageModelLuau(path: string): string {
  return `-- BLOX_MODEL_PREVIEW
local HttpService = game:GetService("HttpService")
${RESOLVE}
local src = resolve(${JSON.stringify(path)})
local parts, guis, sounds = 0, 0, {}
local function count(i)
	if i:IsA("BasePart") then parts += 1 end
	if i:IsA("GuiObject") then guis += 1 end
	if i:IsA("Sound") then table.insert(sounds, { name = i.Name, id = i.SoundId, seconds = math.floor(i.TimeLength * 10) / 10 }) end
end
count(src)
for _, d in src:GetDescendants() do count(d) end
local out = { parts = parts, guis = guis, sounds = sounds }
local old = workspace:FindFirstChild("${MODEL_PREVIEW}")
if old then old:Destroy() end
if parts > 0 then
	local m = Instance.new("Model")
	m.Name = "${MODEL_PREVIEW}"
	local c = src:Clone()
	for _, d in c:GetDescendants() do
		if d:IsA("LuaSourceContainer") then d:Destroy() end
	end
	c.Parent = m
	m.Parent = workspace
	for _, d in m:GetDescendants() do
		if d:IsA("BasePart") then d.Anchored = true end
	end
	m:PivotTo(CFrame.new(${STAGE_AT}))
	local cf, size = m:GetBoundingBox()
	out.center = { cf.Position.X, cf.Position.Y, cf.Position.Z }
	out.size = { size.X, size.Y, size.Z }
end
return HttpService:JSONEncode(out)`;
}

export const unstageModelLuau = `local m = workspace:FindFirstChild("${MODEL_PREVIEW}") if m then m:Destroy() end return "ok"`;

type V3 = [number, number, number];
export function modelCameras(center: V3, size: V3): { label: string; position: V3; lookAt: V3 }[] {
  const d = Math.max(8, Math.hypot(size[0], size[1], size[2]));
  const [x, y, z] = center;
  return [
    { label: 'three-quarter', position: [x + d * 0.55, y + d * 0.35, z + d * 0.55], lookAt: center },
    { label: 'front', position: [x, y + d * 0.1, z + d * 0.8], lookAt: center },
  ];
}

export interface ModelPreview {
  parts: number;
  guis: number;
  sounds: { name: string; id: string; seconds: number }[];
  shots: { label: string; screenshot: Screenshot | null }[];
}

export async function runModelPreview(session: StudioSession, projectPath: string, o: { id: string; path: string }): Promise<ModelPreview> {
  const st = await runLuau(session, stageModelLuau(o.path), 'edit', { chunkName: 'previewModel' });
  if (!st.ok) throw new Error(`preview: could not stage ${o.path}: ${st.error?.message}`);
  const j = JSON.parse(String(st.values[0])) as Omit<ModelPreview, 'shots'> & { center?: V3; size?: V3 };
  const out: ModelPreview = { parts: j.parts, guis: j.guis, sounds: Array.isArray(j.sounds) ? j.sounds : [], shots: [] };
  if (!j.center || !j.size) return out;
  try {
    for (const c of modelCameras(j.center, j.size))
      out.shots.push({ label: c.label, screenshot: await captureScreenshot(session, projectPath, `preview-${o.id}-${c.label}`, { position: c.position, lookAt: c.lookAt }) });
  } finally {
    await runLuau(session, unstageModelLuau, 'edit', { chunkName: 'previewModelDone' }).catch(() => undefined);
  }
  return out;
}

export function formatModelPreview(id: string, path: string, r: ModelPreview): string {
  const lines = [`${id}: ${r.parts} part(s), ${r.guis} GUI object(s), ${r.sounds.length} sound(s) under ${path}`];
  for (const s of r.sounds) lines.push(`  sound ${s.name} ${s.id} — ${s.seconds}s${s.seconds > 0 && s.seconds < 20 ? ' (short: a sting/SFX, not a music loop)' : ''}`);
  for (const s of r.shots) lines.push(`  ${s.label} → ${s.screenshot ? s.screenshot.path : 'screen_capture returned no image'}`);
  if (r.parts > 0 && !r.shots.some((s) => s.screenshot)) lines.push('  no screenshot: is the Studio viewport open?');
  return lines.join('\n');
}
