-- @context client
local Players = game:GetService("Players")
local function label()
	local p = Players.LocalPlayer
	local gui = waitFor(function()
		for _, c in p.PlayerGui:GetChildren() do if c.Name == "HUD" and c:IsA("ScreenGui") then return c end end
		return nil
	end, 10, "no ScreenGui named HUD in PlayerGui")
	return waitFor(function() return gui:FindFirstChild("CoinsLabel", true) end, 5, "no CoinsLabel in HUD")
end
test("hud: CoinsLabel is a visible TextLabel in the top-left quadrant", function()
	local l = label()
	expect(l).toBeA("TextLabel")
	expect(l.Visible).toBe(true)
	local vp = workspace.CurrentCamera.ViewportSize
	expect(l.AbsolutePosition.X < vp.X / 2).toBe(true)
	expect(l.AbsolutePosition.Y < vp.Y / 2).toBe(true)
end)
test('hud: text reads "Coins: N" for the current value', function()
	local l = label()
	local coins = Players.LocalPlayer:WaitForChild("leaderstats"):WaitForChild("Coins")
	waitFor(function() return l.Text == "Coins: " .. coins.Value end, 5, 'label text is "' .. l.Text .. '"')
end)
test("hud: label updates live when Coins changes", function()
	local l = label()
	local coins = Players.LocalPlayer.leaderstats.Coins
	coins.Value = 7
	waitFor(function() return l.Text == "Coins: 7" end, 3, 'label text is "' .. l.Text .. '"')
end)
