-- Map building blocks. Every part is anchored with smooth surfaces; parts
-- smaller than 8 studs cast no shadow (the shadow pass can cost more triangles
-- than the map). Decor pieces meet faces instead of crossing (map check flags
-- overlaps). `style` is a Palette name or { color, material }.
-- Frames: `base` CFrames sit on the ground at a building's centre, +Z = front.
local Palette = require(script.Parent.Palette)

local B = {}
local SQRT2 = math.sqrt(2)
local RAD45 = math.rad(45)

local function styleOf(s: any)
	if type(s) == "string" then
		return assert(Palette.colors[s], "BloxMap: no palette colour " .. s)
	end
	return s or Palette.colors.concrete
end

function B.part(parent: Instance, name: string, size: Vector3, cf: CFrame, style: any, opts: any?): Part
	local st = styleOf(style)
	local p = Instance.new("Part")
	p.Name = name
	p.Anchored = true
	p.Size = size
	p.CFrame = cf
	p.Color = st.color
	p.Material = st.material
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.CastShadow = if opts and opts.shadow ~= nil then opts.shadow else size.Magnitude >= 8
	if st.transparency then
		p.Transparency = st.transparency
	end
	p.Parent = parent
	return p
end

-- axis-aligned box between two corners
function B.box(parent: Instance, name: string, a: Vector3, b: Vector3, style: any, opts: any?): Part
	local lo, hi = a:Min(b), a:Max(b)
	return B.part(parent, name, hi - lo, CFrame.new((lo + hi) / 2), style, opts)
end

function B.model(parent: Instance, name: string): Model
	local m = Instance.new("Model")
	m.Name = name
	m.Parent = parent
	return m
end

function B.folder(parent: Instance, name: string): Folder
	local f = Instance.new("Folder")
	f.Name = name
	f.Parent = parent
	return f
end

-- invisible point (spawns, waypoints): no collision, no raycasts
function B.marker(parent: Instance, name: string, pos: Vector3): Part
	local p = B.part(parent, name, Vector3.new(4, 1, 4), CFrame.new(pos), "white", { shadow = false })
	p.Transparency = 1
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	return p
end

-- ground slab whose top is at y (default 0)
function B.ground(parent: Instance, o: any): Part
	local c = o.centre or Vector3.zero
	local y = o.y or 0
	return B.part(
		parent,
		o.name or "Ground",
		Vector3.new(o.size.X, 4, o.size.Y),
		CFrame.new(c.X, y - 2, c.Z),
		o.style or "grass"
	)
end

---------------------------------------------------------------------------
-- openings and trim (cf on the wall surface, +Z out of the wall)
---------------------------------------------------------------------------
function B.window(parent: Instance, cf: CFrame, w: number, h: number, frame: any?)
	B.part(
		parent,
		"WindowFrame",
		Vector3.new(w + 0.8, h + 0.8, 0.2),
		cf * CFrame.new(0, 0, 0.1),
		frame or "white"
	)
	local g = B.part(parent, "WindowGlass", Vector3.new(w, h, 0.1), cf * CFrame.new(0, 0, 0.25), "glass")
	g.Reflectance = 0.15
	B.part(
		parent,
		"WindowSill",
		Vector3.new(w + 1.2, 0.35, 0.6),
		cf * CFrame.new(0, -h / 2 - 0.58, 0.3),
		frame or "white"
	)
end

function B.door(parent: Instance, cf: CFrame, w: number, h: number, style: any?)
	B.part(parent, "Door", Vector3.new(w, h, 0.2), cf * CFrame.new(0, h / 2, 0.1), style or "wood")
	B.part(parent, "Knob", Vector3.new(0.4, 0.4, 0.3), cf * CFrame.new(w / 2 - 0.6, h * 0.45, 0.35), "yellow")
end

---------------------------------------------------------------------------
-- roofs (local frame: ridge along X, length L, depth D, wall height H)
---------------------------------------------------------------------------
-- 45° gable: a solid attic prism (its lower half hidden in the walls) + two slopes + ridge cap
function B.gableRoof(
	parent: Instance,
	base: CFrame,
	L: number,
	D: number,
	H: number,
	wallStyle: any,
	roofStyle: any?
)
	local s = D / SQRT2
	B.part(
		parent,
		"Gable",
		Vector3.new(L, s, s),
		base * CFrame.new(0, H, 0) * CFrame.Angles(RAD45, 0, 0),
		wallStyle
	)
	local o, t = 0.75, 0.8
	for _, sz in { -1, 1 } do
		local mid = Vector3.new(0, H + D / 4, sz * D / 4)
		local normal = Vector3.new(0, 1, sz) / SQRT2
		local down = Vector3.new(0, -1, sz) / SQRT2
		local c = mid + normal * (t / 2) + down * (o / 2)
		B.part(
			parent,
			"Roof",
			Vector3.new(L + 2 * o, t, s + o),
			base * CFrame.new(c) * CFrame.Angles(sz * RAD45, 0, 0),
			roofStyle or "roofGrey"
		)
	end
end

function B.flatRoof(parent: Instance, base: CFrame, L: number, D: number, H: number, roofStyle: any?)
	B.part(
		parent,
		"Roof",
		Vector3.new(L + 1.5, 1, D + 1.5),
		base * CFrame.new(0, H + 0.5, 0),
		roofStyle or "roofGrey"
	)
end

---------------------------------------------------------------------------
-- buildings
---------------------------------------------------------------------------
-- o: L, D, H, style, roof = "gable"|"flat", roofStyle, enterable, door = {w, h}, windows (default true)
-- Enterable: a walkable ground storey (height G = min(11, H)) behind a real door gap, a
-- solid upper storey, and an invisible "InteriorVolume" tagged Interior (map check
-- treats covered points inside it as meant). Closed: one solid body.
function B.house(parent: Instance, name: string, base: CFrame, o: any): Model
	local m = B.model(parent, name)
	local L, D, H = o.L, o.D, o.H
	local style = o.style or "cream"
	local DW, DH = (o.door and o.door.w) or 6, (o.door and o.door.h) or 8
	local T = 1
	local front = D / 2
	if o.enterable then
		m:SetAttribute("Enterable", true)
		local G = math.min(11, H)
		if H > G then
			B.part(m, "UpperFloor", Vector3.new(L, H - G, D), base * CFrame.new(0, G + (H - G) / 2, 0), style)
		end
		B.part(m, "Floor", Vector3.new(L - 2 * T, 0.3, D - 2 * T), base * CFrame.new(0, 0.15, 0), "wood")
		B.part(m, "BackWall", Vector3.new(L, G, T), base * CFrame.new(0, G / 2, -front + T / 2), style)
		for _, sx in { -1, 1 } do
			B.part(
				m,
				"SideWall",
				Vector3.new(T, G, D - 2 * T),
				base * CFrame.new(sx * (L / 2 - T / 2), G / 2, 0),
				style
			)
		end
		local seg = (L - DW) / 2
		for _, sx in { -1, 1 } do
			B.part(
				m,
				"FrontWall",
				Vector3.new(seg, G, T),
				base * CFrame.new(sx * (DW / 2 + seg / 2), G / 2, front - T / 2),
				style
			)
		end
		if G > DH then
			B.part(
				m,
				"Lintel",
				Vector3.new(DW, G - DH, T),
				base * CFrame.new(0, DH + (G - DH) / 2, front - T / 2),
				style
			)
		end
		B.part(m, "Step", Vector3.new(DW + 2, 0.4, 2.5), base * CFrame.new(0, 0.2, front + 1.25), "concrete")
		local vol = B.part(
			m,
			"InteriorVolume",
			Vector3.new(L - 2 * T, G - 0.4, D - 2 * T),
			base * CFrame.new(0, G / 2, 0),
			"white",
			{ shadow = false }
		)
		vol.Transparency = 1
		vol.CanCollide = false
		vol.CanQuery = false
		vol.CanTouch = false
		vol:AddTag("Interior")
		if o.windows ~= false then
			for _, sx in { -1, 1 } do
				B.window(m, base * CFrame.new(sx * L * 0.3, 5.5, front), 4, 4)
				B.window(
					m,
					base * CFrame.new(sx * L / 2, 5.5, 0) * CFrame.Angles(0, sx * math.pi / 2, 0),
					5,
					4
				)
				if H > G + 6 then
					B.window(m, base * CFrame.new(sx * L * 0.25, G + (H - G) / 2, front), 3.5, 4.5)
				end
			end
		end
	else
		B.part(m, "Body", Vector3.new(L, H, D), base * CFrame.new(0, H / 2, 0), style)
		B.door(m, base * CFrame.new(0, 0, front), DW, DH)
		if o.windows ~= false then
			for _, sx in { -1, 1 } do
				B.window(m, base * CFrame.new(sx * L * 0.3, math.min(H - 3, 5.5), front), 3.5, 3.5)
			end
		end
	end
	if o.roof == "flat" then
		B.flatRoof(m, base, L, D, H, o.roofStyle)
	else
		B.gableRoof(m, base, L, D, H, style, o.roofStyle)
	end
	return m
end

---------------------------------------------------------------------------
-- boundary, roads
---------------------------------------------------------------------------
-- Four visible walls (with caps) around centre/size, plus a taller invisible
-- barrier just inside each, so nobody climbs or glitches out.
function B.boundary(parent: Instance, o: any): Folder
	local f = B.folder(parent, o.name or "Boundary")
	local c, sz = o.centre or Vector3.zero, o.size
	local H, T = o.height or 28, o.thickness or 4
	local bar = o.barrier or H + 40
	local hx, hz = sz.X / 2, sz.Y / 2
	local sides = {
		{ Vector3.new(sz.X + 2 * T, H, T), Vector3.new(0, 0, -hz - T / 2) },
		{ Vector3.new(sz.X + 2 * T, H, T), Vector3.new(0, 0, hz + T / 2) },
		{ Vector3.new(T, H, sz.Y), Vector3.new(-hx - T / 2, 0, 0) },
		{ Vector3.new(T, H, sz.Y), Vector3.new(hx + T / 2, 0, 0) },
	}
	for _, s in sides do
		local pos = c + s[2]
		B.part(f, "Wall", s[1], CFrame.new(pos.X, H / 2, pos.Z), o.style or "brickRed")
		B.part(
			f,
			"WallCap",
			Vector3.new(s[1].X + 0.4, 1, s[1].Z + 0.4),
			CFrame.new(pos.X, H + 0.5, pos.Z),
			o.capStyle or "grassDark"
		)
		local w = B.part(
			f,
			"Barrier",
			Vector3.new(s[1].X, bar, s[1].Z),
			CFrame.new(pos.X, H + 1 + bar / 2, pos.Z),
			"white",
			{ shadow = false }
		)
		w.Transparency = 1
	end
	return f
end

-- Straight road between two points (along X or Z, whichever is longer), kerbs both sides,
-- optional sidewalks (o.sidewalk = width) and a dashed centre line (o.line ~= false).
function B.road(parent: Instance, a: Vector3, b: Vector3, o: any?): Model
	o = o or {}
	local m = B.model(parent, o.name or "Road")
	local W = o.width or 16
	local alongX = math.abs(b.X - a.X) >= math.abs(b.Z - a.Z)
	local len = if alongX then math.abs(b.X - a.X) else math.abs(b.Z - a.Z)
	local mid = (a + b) / 2
	local y = o.y or 0
	local function at(across: number, h: number): CFrame
		return if alongX
			then CFrame.new(mid.X, y + h, mid.Z + across)
			else CFrame.new(mid.X + across, y + h, mid.Z)
	end
	local function size(width: number, h: number): Vector3
		return if alongX then Vector3.new(len, h, width) else Vector3.new(width, h, len)
	end
	B.part(m, "Asphalt", size(W, 0.2), at(0, 0.1), "road")
	for _, s in { -1, 1 } do
		B.part(m, "Kerb", size(1, 0.6), at(s * (W / 2 + 0.5), 0.3), "kerb")
		if o.sidewalk then
			B.part(
				m,
				"Sidewalk",
				size(o.sidewalk, 0.6),
				at(s * (W / 2 + 1 + o.sidewalk / 2), 0.3),
				"concrete"
			)
		end
	end
	if o.line ~= false then
		local dash, gap = 6, 6
		local n = math.floor(len / (dash + gap))
		for i = 0, n - 1 do
			local off = -len / 2 + (dash + gap) * i + dash / 2 + gap / 2
			local cf = if alongX
				then CFrame.new(mid.X + off, y + 0.22, mid.Z)
				else CFrame.new(mid.X, y + 0.22, mid.Z + off)
			B.part(
				m,
				"Line",
				if alongX then Vector3.new(dash, 0.05, 0.6) else Vector3.new(0.6, 0.05, dash),
				cf,
				"yellow",
				{ shadow = false }
			)
		end
	end
	return m
end

---------------------------------------------------------------------------
-- props (pos = ground point under the prop's centre)
---------------------------------------------------------------------------
function B.crate(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local S = o.size or 4
	local cf = CFrame.new(pos + Vector3.new(0, S / 2, 0)) * CFrame.Angles(0, math.rad(o.yaw or 0), 0)
	local m = B.model(parent, "Crate")
	B.part(m, "Body", Vector3.new(S, S, S), cf, "woodDark")
	local p = S * 0.78
	for _, f in
		{
			CFrame.new(0, 0, S / 2 + 0.05),
			CFrame.new(0, 0, -S / 2 - 0.05),
			CFrame.new(S / 2 + 0.05, 0, 0) * CFrame.Angles(0, math.pi / 2, 0),
			CFrame.new(-S / 2 - 0.05, 0, 0) * CFrame.Angles(0, math.pi / 2, 0),
		}
	do
		B.part(m, "Panel", Vector3.new(p, p, 0.1), cf * f, "wood")
	end
	return m
end

function B.bale(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local L, H, D = o.length or 7, 4, 4
	local cf = CFrame.new(pos + Vector3.new(0, H / 2, 0)) * CFrame.Angles(0, math.rad(o.yaw or 0), 0)
	local m = B.model(parent, "HayBale")
	B.part(m, "Hay", Vector3.new(L, H, D), cf, "hay")
	for _, s in { -1, 1 } do
		local x = s * L * 0.3
		B.part(m, "Strap", Vector3.new(0.5, 0.1, D), cf * CFrame.new(x, H / 2 + 0.05, 0), "strap")
		B.part(m, "Strap", Vector3.new(0.5, H, 0.1), cf * CFrame.new(x, 0, D / 2 + 0.05), "strap")
		B.part(m, "Strap", Vector3.new(0.5, H, 0.1), cf * CFrame.new(x, 0, -D / 2 - 0.05), "strap")
	end
	return m
end

-- posts every `spacing` studs with rails between them (rails stop at the posts)
function B.fence(parent: Instance, a: Vector3, b: Vector3, o: any?): Model
	o = o or {}
	local m = B.model(parent, "Fence")
	local H, sp, P = o.height or 4, o.spacing or 6, 0.6
	local d = Vector3.new(b.X - a.X, 0, b.Z - a.Z)
	local len = d.Magnitude
	local dir = d.Unit
	local n = math.max(1, math.floor(len / sp + 0.5))
	local step = len / n
	local yaw = math.atan2(-dir.Z, dir.X)
	for i = 0, n do
		local p = a + dir * (step * i)
		B.part(
			m,
			"Post",
			Vector3.new(P, H, P),
			CFrame.new(p.X, (o.y or 0) + H / 2, p.Z) * CFrame.Angles(0, yaw, 0),
			"woodDark"
		)
		if i < n then
			local c = a + dir * (step * (i + 0.5))
			for _, h in { H * 0.4, H * 0.8 } do
				B.part(
					m,
					"Rail",
					Vector3.new(step - P, 0.4, 0.3),
					CFrame.new(c.X, (o.y or 0) + h, c.Z) * CFrame.Angles(0, yaw, 0),
					"wood"
				)
			end
		end
	end
	return m
end

function B.pole(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local m = B.model(parent, "Pole")
	local H = o.height or 18
	B.part(m, "Post", Vector3.new(0.9, H, 0.9), CFrame.new(pos + Vector3.new(0, H / 2, 0)), "woodDark")
	B.part(
		m,
		"Crossbar",
		Vector3.new(5, 0.5, 0.5),
		CFrame.new(pos + Vector3.new(0, H - 1.5, 0.7)),
		"woodDark",
		{ shadow = false }
	)
	return m
end

function B.lamp(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local m = B.model(parent, "Lamp")
	local H = o.height or 9
	B.part(
		m,
		"Post",
		Vector3.new(0.5, H, 0.5),
		CFrame.new(pos + Vector3.new(0, H / 2, 0)),
		"metal",
		{ shadow = false }
	)
	local head =
		B.part(m, "Head", Vector3.new(1.4, 1, 1.4), CFrame.new(pos + Vector3.new(0, H + 0.5, 0)), "neonWarm")
	local l = Instance.new("PointLight")
	l.Range = o.range or 20
	l.Brightness = 1.2
	l.Color = Color3.fromRGB(255, 236, 200)
	l.Parent = head
	return m
end

-- blocky tree: trunk + two stacked leaf blocks (cheap, reads well from above)
function B.tree(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local k = o.scale or 1
	local m = B.model(parent, "Tree")
	local th = 6 * k
	B.part(
		m,
		"Trunk",
		Vector3.new(1.4 * k, th, 1.4 * k),
		CFrame.new(pos + Vector3.new(0, th / 2, 0)),
		"trunk"
	)
	B.part(
		m,
		"Leaves",
		Vector3.new(7 * k, 5 * k, 7 * k),
		CFrame.new(pos + Vector3.new(0, th + 2.5 * k, 0)),
		o.style or "leaf"
	)
	B.part(
		m,
		"Leaves",
		Vector3.new(4.5 * k, 3 * k, 4.5 * k),
		CFrame.new(pos + Vector3.new(0, th + 6.5 * k, 0)) * CFrame.Angles(0, RAD45, 0),
		o.style or "leaf"
	)
	return m
end

-- 8-sided silo from flat panels (a Cylinder part costs far more triangles)
function B.silo(parent: Instance, pos: Vector3, o: any?): Model
	o = o or {}
	local m = B.model(parent, "Silo")
	local R, H = o.radius or 6, o.height or 28
	local w = 2 * R * math.tan(math.pi / 8)
	for i = 0, 7 do
		local a = i * math.pi / 4
		local cf = CFrame.new(pos + Vector3.new(0, H / 2, 0))
			* CFrame.Angles(0, a, 0)
			* CFrame.new(0, 0, R - 0.5)
		B.part(m, "Panel", Vector3.new(w, H, 1), cf, o.style or "metal")
	end
	B.part(
		m,
		"Cap",
		Vector3.new(R * 1.5, 1.2, R * 1.5),
		CFrame.new(pos + Vector3.new(0, H + 0.6, 0)),
		"roofGrey"
	)
	B.part(
		m,
		"Top",
		Vector3.new(R * 0.9, 1.2, R * 0.9),
		CFrame.new(pos + Vector3.new(0, H + 1.8, 0)) * CFrame.Angles(0, RAD45, 0),
		"roofGrey"
	)
	return m
end

return B
