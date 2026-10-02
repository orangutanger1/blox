--!strict
-- Plays uploaded animations on a rigged model (Bones or Motor6Ds) from server
-- or client code. Animations play only in places owned by the user or group
-- that uploaded them.
--
--   local track = BloxAnimate.play(model, 87111650999140)          -- one-shot / loop
--   local stop = BloxAnimate.auto(model, { idle = 1, walk = 2 })   -- idle/walk by speed

local BloxAnimate = {}

local function animatorOf(model: Instance): Animator
	local host: Instance? = model:FindFirstChildWhichIsA("Humanoid", true)
		or model:FindFirstChildWhichIsA("AnimationController", true)
	if not host then
		local controller = Instance.new("AnimationController")
		controller.Parent = model
		host = controller
	end
	local parent = host :: Instance
	local found = parent:FindFirstChildOfClass("Animator")
	if found then
		return found
	end
	local animator = Instance.new("Animator")
	animator.Parent = parent
	return animator
end

local cache: { [Animator]: { [string]: AnimationTrack } } = setmetatable({}, { __mode = "k" }) :: any

function BloxAnimate.track(model: Instance, id: number | string): AnimationTrack
	local animator = animatorOf(model)
	local key = if type(id) == "number" then "rbxassetid://" .. id else id
	local tracks = cache[animator]
	if not tracks then
		tracks = {}
		cache[animator] = tracks
	end
	local existing = tracks[key]
	if existing then
		return existing
	end
	local animation = Instance.new("Animation")
	animation.AnimationId = key
	local track = animator:LoadAnimation(animation)
	tracks[key] = track
	return track
end

function BloxAnimate.play(model: Instance, id: number | string, fade: number?): AnimationTrack
	local track = BloxAnimate.track(model, id)
	track:Play(fade or 0.2)
	return track
end

-- Idle while still, walk while the model moves faster than `threshold`
-- studs/s (its PrimaryPart's velocity, or a Humanoid's MoveDirection).
function BloxAnimate.auto(model: Model, ids: { idle: number?, walk: number? }, threshold: number?): () -> ()
	local limit = threshold or 0.5
	local humanoid = model:FindFirstChildWhichIsA("Humanoid", true)
	local current: AnimationTrack? = nil
	local function set(id: number?)
		local nextTrack = if id then BloxAnimate.track(model, id) else nil
		if nextTrack == current then
			return
		end
		if current then
			current:Stop(0.2)
		end
		current = nextTrack
		if nextTrack then
			nextTrack:Play(0.2)
		end
	end
	local running = true
	task.spawn(function()
		while running and model.Parent do
			local root = model.PrimaryPart
			local moving = if humanoid
				then (humanoid :: Humanoid).MoveDirection.Magnitude > 0.1
				else root ~= nil and root.AssemblyLinearVelocity.Magnitude > limit
			set(if moving then ids.walk or ids.idle else ids.idle)
			task.wait(0.1)
		end
	end)
	return function()
		running = false
		set(nil)
	end
end

return BloxAnimate
