# Roblox Assistant vs blox on t8-pet-hatch (2026-10-01/02)

Task: `bench/tasks/t8-pet-hatch`. It asks for the core economy of a pet-collection
simulator:
- config and logic modules;
- server-authoritative hatching with weighted rarity, a 12-pet cap, and protection
  against a client choosing its rarity;
- passive income per tick with a rebirth multiplier;
- rebirth;
- a HUD that works on phones;
- a world EggStation with a ProximityPrompt.

Both sides got the identical prompt and the identical seed (baseplate and spawn only).
Both were judged by the same 15 hidden checks, executed in a live playtest:
- 3 edit-context checks: logic;
- 3 server checks;
- 9 client checks.

## Result

| | blox runner (Opus 5.5) | Roblox Assistant (Planning Mode) |
|---|---|---|
| hidden checks (live) | **15/15** | **14/15** |
| failed check | — | HUD label shows `Cash: 4321 (Rebirths: 2)` once Rebirths > 0; contract said `Cash: N` |
| time | 103 s (harness-measured) | **~7.5 min** (user: started 23:10:30, finished ~23:18) |
| model requests / tool calls | 5 turns, 4 blox calls, 0 errors | not observable |
| human interventions | 0 | **several** — user had to approve individual actions during the run |
| cost | $0.53 API-equivalent (subscription, not charged) | Assistant usage quota (no $ figure exposed) |
| where code lives | files (`src/`, `tests/`), git-committed, synced to Studio | directly in the place (no files) |
| its own tests | 3 spec files, 9 tests: logic **and** live economy/remotes/HUD checks, re-runnable via `run_tests` | 1 `Script` in ServerScriptService, 10 print-based asserts, logic only. It runs on every server start, so it **ships to production** |
| HUD update | event-driven | 0.5 s polling loop |

Assistant's build is saved in `assistant-t8-build/`. blox's run is in
`t8-blox-opus55.{md,json}`; its workdir is under `bench/runs/` (git-ignored).

## Reading

- **On mechanics, they are effectively tied.** Assistant got every piece of game
  logic, security and world setup right. Its one miss is a deviation from the spec: it
  added a rebirth suffix to the cash label. A player would not mind, but an automated
  contract (or a teammate's code reading the label) would.
- **The process differs more than the score.** blox leaves re-runnable tests, both
  logic and in-game, in version control. Assistant left a print-based test script
  inside the shipped game, and there are no files to diff, review or roll back.
- **n = 1 per side and one task.** This is a signal, not a ranking. The task is also
  fully specified. The interesting gaps (design judgment, larger multi-system
  builds) are not measured here.

## Visuals

- blox: `t8-blox-opus55-screenshot.jpg`. The cash pill sits top-centre, with two
  phone-sized buttons at the bottom and a pale ball as the EggStation. It is
  functional programmer art.
- Assistant: **not captured.** Re-validating the task reset the place before
  screenshots were taken. Only the scripts were exported. The GUI layout and the
  EggStation look were lost.

  Lesson for the harness: snapshot the place (serialize GUI/world properties, or
  screenshot) before any reset.
- Assistant can run on Claude, OpenAI or Gemini with a user-supplied API key (Studio
  "Manage API Keys", Feb–Mar 2026). This run used its default model.
