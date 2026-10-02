-- Display formatting shared by HUD and server messages.
local Format = {}

local SUFFIXES = { "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc" }

-- 3 significant digits with a suffix: 999, 1.23K, 12.3K, 123K, 4.56M.
function Format.abbreviate(n: number): string
	if n ~= n then
		return "NaN"
	end
	if n == math.huge then
		return "inf"
	end
	local sign = n < 0 and "-" or ""
	n = math.abs(n)
	if n < 1000 then
		return sign .. tostring(math.floor(n))
	end
	local tier = math.min(math.floor(math.log10(n) / 3), #SUFFIXES)
	local v = n / 10 ^ (tier * 3)
	-- floor (never round up into the next tier: 999.96K stays 999K)
	local text
	if v < 10 then
		text = string.format("%.2f", math.floor(v * 100 + 1e-6) / 100)
	elseif v < 100 then
		text = string.format("%.1f", math.floor(v * 10 + 1e-6) / 10)
	else
		text = tostring(math.floor(v + 1e-6))
	end
	return sign .. text .. SUFFIXES[tier]
end

-- 38s, 12m05s, 1h02m (matches the design report).
function Format.duration(sec: number): string
	local r = math.floor(sec + 0.5)
	if r < 60 then
		return r .. "s"
	elseif r < 3600 then
		return string.format("%dm%02ds", r // 60, r % 60)
	end
	return string.format("%dh%02dm", r // 3600, (r % 3600) // 60)
end

return Format
