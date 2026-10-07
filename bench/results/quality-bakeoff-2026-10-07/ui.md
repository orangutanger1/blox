# Task 2 — UI: the ZA shop window

Build Zombie Attack's **Menu window** with its Shop tab, for Dog Attack. References: HUD frames in
`video/f_*_sheet*.jpg` and `images/wiki/RobloxScreenShot*.png` (cash panel `$2.94M` + green `+`, orange menu
button, yellow inventory button), `wiki/Shop.wiki`, `wiki/Guns_List.wiki`, `wiki/Gun_Upgrade.wiki`.

Must have:
- HUD: cash panel top-left with a green `+`, the orange menu button and the yellow inventory button under it.
  The orange menu button opens the Menu window.
- Menu window: a left column with CASH (amount) and the tabs Shop / Inventory / ROBUX Shop; a close button.
- Shop tab: lists the guns in order. Each row shows the gun's icon, name, a stats line and its state:
  owned (with an Upgrade button showing the upgrade price, or MAX), next (Buy with price; shows when you can't
  afford it), or locked (later guns).
- Confirm dialog, e.g. "Buy Uzi for $600?" with Buy / Cancel.
- Inventory and ROBUX Shop tabs may be simple placeholders, but must look finished.
- ZA colours: green panels, orange menu button, white text with a dark outline.
- Real icon images for guns and buttons, never emoji or text glyphs as icons.
- Must work and look right on phone (portrait and landscape), tablet and 1080p desktop: readable text,
  tap targets big enough for a thumb, nothing overlapping or cut off.
- Data comes from one config table with at least 6 guns (use the real ZA order and prices from the wiki,
  starting Pistol free, Revolver $250, Uzi $600, ...) including upgrade prices.
- Buying/upgrading may be client-side demo state for this task (no DataStore needed), but the rules
  (can I buy this? what's next? upgrade price) must be real code driven by the config.

Contract (so the judging scripts can drive every state; names are exact):
- A ModuleScript `ReplicatedStorage.BakeoffUI` that a client-context script can `require`, returning a table:
  - `setDemo(cash: number, ownedCount: number)` — set cash and own the first `ownedCount` guns, refresh the UI.
  - `open(tabName: string?)` — open the Menu window on "Shop" (default), "Inventory" or "Robux".
  - `confirm(gunName: string)` — show the confirm dialog for that gun (e.g. "Uzi").
  - `close()` — close dialog and window.
- The UI lives in the local player's PlayerGui during play and must not need anything else to be clicked first.
