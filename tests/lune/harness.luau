-- Offline runner for blox `edit` specs under Lune (https://lune-org.github.io).
-- Usage: lune run harness.luau <projectDir> <spec>...   → one JSON line {results, fileErrors}.
-- game:GetService("X") maps to <project>/src/X; require() of such a path loads
-- <path>.luau / <path>.lua / <path>/init.luau. Pure-logic modules only: no Instances.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local task = require("@lune/task")

local root = process.args[1]
local specFiles = { table.unpack(process.args, 2) }

local PATH = {}
local function isProxy(v)
	return type(v) == "table" and rawget(v, PATH) ~= nil
end
local function resolveFile(p)
	for _, c in { p .. ".luau", p .. ".lua", p .. "/init.luau", p .. "/init.lua" } do
		if fs.isFile(c) then
			return c
		end
	end
	return nil
end
local proxy
local function exists(p)
	return fs.isDir(p) or resolveFile(p) ~= nil
end
proxy = function(p, name)
	local self = { [PATH] = p, Name = name }
	return setmetatable(self, {
		__index = function(_, k)
			if k == "WaitForChild" or k == "FindFirstChild" then
				return function(_, child)
					local cp = p .. "/" .. child
					if k == "FindFirstChild" and not exists(cp) then
						return nil
					end
					return proxy(cp, child)
				end
			end
			if type(k) ~= "string" then
				return nil
			end
			-- No fs calls here: Lune fs yields, and metamethods cannot yield.
			-- A missing path surfaces at require() instead.
			return proxy(p .. "/" .. k, k)
		end,
	})
end

local game = setmetatable({}, {
	__index = function(_, k)
		if k == "GetService" then
			return function(_, svc)
				return proxy(root .. "/src/" .. svc, svc)
			end
		end
		return proxy(root .. "/src/" .. k, k)
	end,
})

local cache = {}
local env
local function bloxRequire(target)
	if not isProxy(target) then
		error("offline require supports game:GetService(...) paths only, got " .. typeof(target), 2)
	end
	local file = resolveFile(rawget(target, PATH))
	if not file then
		error("no module at " .. rawget(target, PATH), 2)
	end
	if cache[file] == nil then
		local fn = luau.load(fs.readFile(file), { debugName = file, environment = env })
		cache[file] = fn()
	end
	return cache[file]
end

local function fmt(v)
	if type(v) == "string" then
		return string.format("%q", v)
	end
	return tostring(v)
end
local function deepEq(a, b)
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	for k, v in a do
		if not deepEq(v, b[k]) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end
local function expect(actual)
	local m = {}
	local function check(cond, msg)
		if not cond then
			error(msg, 3)
		end
	end
	function m.toBe(e) check(actual == e, "expected " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toEqual(e) check(deepEq(actual, e), "expected deep-equal " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeTruthy() check(actual, "expected truthy, got " .. fmt(actual)) end
	function m.toBeFalsy() check(not actual, "expected falsy, got " .. fmt(actual)) end
	function m.toBeNil() check(actual == nil, "expected nil, got " .. fmt(actual)) end
	function m.toExist() check(actual ~= nil, "expected a value/instance, got nil") end
	function m.toBeGreaterThan(e) check(type(actual) == "number" and actual > e, "expected > " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeGreaterThanOrEqual(e) check(type(actual) == "number" and actual >= e, "expected >= " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeLessThan(e) check(type(actual) == "number" and actual < e, "expected < " .. fmt(e) .. ", got " .. fmt(actual)) end
	function m.toBeCloseTo(e, eps)
		eps = eps or 1e-3
		check(type(actual) == "number" and math.abs(actual - e) <= eps, "expected ~" .. fmt(e) .. ", got " .. fmt(actual))
	end
	function m.toContain(e)
		if type(actual) == "string" then
			check(string.find(actual, e, 1, true) ~= nil, "expected " .. fmt(actual) .. " to contain " .. fmt(e))
			return
		end
		local found = false
		if type(actual) == "table" then
			for _, v in actual do
				if v == e then
					found = true
				end
			end
		end
		check(found, "expected table to contain " .. fmt(e))
	end
	function m.toBeA(cls) check(typeof(actual) == cls, "expected a " .. cls .. ", got " .. typeof(actual)) end
	function m.toThrow(pat)
		local ok, err = pcall(actual)
		check(not ok, "expected function to throw")
		if pat then
			check(string.find(tostring(err), pat, 1, true) ~= nil, "expected error containing " .. fmt(pat) .. ", got " .. fmt(err))
		end
	end
	return m
end
local function waitFor(pred, timeout, msg)
	local deadline = os.clock() + (timeout or 5)
	while os.clock() < deadline do
		local ok, v = pcall(pred)
		if ok and v then
			return v
		end
		task.wait(0.05)
	end
	error("waitFor timed out" .. (msg and (": " .. msg) or ""), 2)
end

env = { game = game, require = bloxRequire, task = task, expect = expect, waitFor = waitFor }

local results, fileErrors = {}, {}
for _, file in specFiles do
	local tests = {}
	local prefix = ""
	local function test(name, fn) table.insert(tests, { name = prefix .. name, fn = fn }) end
	local function describe(name, fn)
		local old = prefix
		prefix = prefix .. name .. " > "
		fn()
		prefix = old
	end
	-- Flat table: Lune sets its own metatable on load environments (globals injection).
	local specEnv = { test = test, it = test, describe = describe }
	for k, v in env do
		specEnv[k] = v
	end
	local ok, err = pcall(function()
		local fn = luau.load(fs.readFile(root .. "/" .. file), { debugName = file, environment = specEnv })
		fn()
	end)
	if not ok then
		table.insert(fileErrors, { file = file, message = tostring(err) })
	else
		for _, t in tests do
			local passed, msg = xpcall(t.fn, function(e) return tostring(e) end)
			table.insert(results, { file = file, name = t.name, status = passed and "pass" or "fail", message = (not passed) and msg or nil })
		end
	end
end
print(serde.encode("json", { results = results, fileErrors = fileErrors }))
