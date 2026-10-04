---
name: ui-packs
description: Build game menus from an adopted UI pack's own panels (clone and rewire its templates) instead of restyling BloxUI; preview the pack first, check it on phones, wire shared toasts.
---
# Menus from a UI pack

A pack's value is its art: panel frames, title tabs, buttons, icons. Taking only
its colours and rebuilding menus with BloxUI loses that. Use the pack's own
panels as templates.

## Loop

1. scout {action:"try", asset_id, id, kind:"ui"} → note the panel count.
2. scout {action:"preview", id} → one screenshot per panel, each shown alone,
   visible and sized. Packs often hide panels (Visible=false, or Size 0 for an
   open tween); preview shows them anyway and says which were hidden or had no
   size. show_all:true also reveals hidden inner elements (tabs, states).
3. Pick the panels you need (shop, inventory, settings, confirm dialog, HUD
   pills). Discard the pack if none fit.
4. scout {action:"adopt", id, to:"ReplicatedStorage.UiTemplates"} (not
   StarterGui: templates are cloned by code, not shown at spawn).
5. In a client script, clone a template into your ScreenGui per menu:
   ```lua
   local T = game.ReplicatedStorage.UiTemplates
   local shop = T.ShopFrame:Clone()
   shop.Visible = false
   shop.Size = UDim2.fromScale(0.62, 0.7) -- give it a real size if it was 0
   shop.Parent = gui
   shop.Title.Text = "Shop"
   -- item cards: clone the pack's card template once per item
   local card = shop.Items.Template
   card.Parent = nil
   for _, item in items do
     local c = card:Clone()
     c.Name = item.id
     c.Label.Text = item.name
     c.Parent = shop.Items
   end
   ```
   Keep the pack's ImageLabels, 9-slice and UIStroke; change text, icons,
   layout counts. Rewire buttons in code (scripts were stripped on adopt).
6. ui {action:"lint"} with prepare opening each menu (lint syncs first), then
   playtest with a screenshot of each open menu.

## Phones

Check before building on a pack: many packs size panels with offsets designed
at 1920×1080. Preview, then ui lint on phone-landscape/phone-portrait.
Fix by switching outer frames to scale sizes with UIAspectRatioConstraint and a
UISizeConstraint (min touch target 44px for buttons, close X included — packs'
X buttons are often 24–32px; enlarge the hit area with a transparent parent
button rather than stretching the art).

## Toasts and pop-ups

One shared toast stack for HUD and menus (BloxUI Toast, or the pack's toast
panel cloned into one queue module). Two stacks overlap on small screens.

## Conventions top games share

Centred modal with a title tab breaking the top edge and a red X top-right;
item grid with rarity-coloured cards and a tooltip card beside the selection;
category icon strip on the panel's left edge; green = buy/confirm, red =
close/cancel; currency pills top-right or a left stack; menu icon rail on one
screen edge; one big bottom-centre action button on mobile.
