-- Syntax-check Luau files: lune run check.luau <file>... → one line per failure.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
for _, f in process.args do
	local ok, err = pcall(luau.compile, fs.readFile(f))
	if not ok then
		print(f .. ": " .. tostring(err):gsub("\n", " "))
	end
end
