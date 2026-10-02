# What an AI agent needs to make a successful Roblox game (researched 2026-10-01)

Companion to `2026-09-30-landscape.md`, which covered the Studio MCP and AI coding
tools. That document answered "how does an agent touch Studio". This one asks the
larger question: what does it take to go from an idea to a game that players choose,
keep coming back to, and pay for, and how much of that an agent can do.

**Evidence labels**, used throughout:

- **[V]** verified by us: live data we pulled, or behaviour we observed in Studio.
- **[D]** official Roblox (or vendor) documentation and announcements.
- **[3P]** third-party reporting: press, trackers, community write-ups.
- **[C]** a vendor's claim about its own product, not checked.
- **[I]** our own inference.

Dates matter. This market and its tooling change monthly.

**Where the requested deliverables live:**

| Deliverable | Section |
|---|---|
| A. Market | §A |
| B. Game anatomy | §B, plus §C (presentation) |
| C. AI landscape | §G, §H |
| D. Tool matrix | §N |
| E. Pipeline | §O |
| F. Gaps | §P |
| G. Architecture | §Q |
| H. Opportunities | §R |
| I. Example workflows | §S |
| Possible vs speculative | §M |
| Answer to the final question | §T |

---

## Summary

1. **The Roblox market runs on formats, not originality.** Our 2026-10-01 snapshot
   pulled all 41 games in the live Up-and-Coming sort. Every one was created in 2026.
   22 of the 41 reuse the vocabulary of the current hit format: egg, animal, steal, or
   "+1". 19 are small-server "Tycoon"s, with a median of 5 players per server. The top
   game, *Steal An Egg* (created 2026-07-25), had 1.28M concurrent players. That is 30%
   of everything live across the 97-game Top Playing Now sort. [V]

   What wins at the rising tier is a fast, polished remix of a proven loop, presented
   with a near-standard thumbnail and description. That is very good news for an AI
   agent, because remixing a known structure well is exactly the task agents can do
   reliably.
2. **Discovery now rewards long-term retention plus monetization, not clicks.**
   - **June 2026:** "Recommended For You" moved from a 7-day to a 28-day window,
     measured at D1, D2–7 and D8–28. [D]
   - **August 2026:** games strong in *both* retention and monetization get broader
     distribution. [D]

   Thumbnails still decide the click: personalization picks among up to 5 by qualified
   play-through rate. But a game that wins the click and then loses the player is now
   penalized. The agent must optimize the first session and the D7 loop, not only the
   storefront.
3. **Roblox is commoditizing prompt-to-prototype.** Its first-party efforts are:
   - Assistant: planning mode, a playtest subagent, Studio MCP and procedural models.
   - The mobile "Build" app.
   - Cube 3D/4D generation.
   - A Scene Generator due "later this year". [D]

   Roblox also claims whole games in 10–15 minutes. [D] An external agent will not win
   on "generate a game". It wins on what Roblox does not ship:
   - deterministic verification;
   - genre-correct design;
   - multiplayer testing;
   - asset and presentation pipelines;
   - the post-launch analytics loop.
4. **Every stage the agent needs is reachable by an API today; most of them only
   recently.**
   - Studio MCP, StudioTestService multiplayer tests (≤8 clients), VirtualInput and
     StudioDeviceSimulatorService. [D]
   - Open Cloud for place publishing, assets (fbx/gltf/rbxm/audio/images), Luau
     Execution, Configs/Experiments, the Analytics Query API and the Thumbnail
     Personalization API. The last of these arrived 2026-08-24. [D]

   The missing piece is the harness that chains these together with checks. That
   harness is blox's job.
5. **The hard limits that remain:**
   - Judging fun and visual appeal. An LLM judging its own playtest gives false passes,
     which Roblox itself acknowledges. [D]
   - Consistent art direction across generated assets.
   - Character animation quality.
   - Real-player social dynamics.
   - Anything that spends money or publishes. That needs a human, by policy rather than
     ability.

---

## A. Roblox market findings

### A.1 What is live right now: snapshot 2026-10-01 [V]

Source: the public `explore-api` sorts plus `games.roblox.com/v1/games`. 281 unique
universes; data and scripts are in `data/2026-10-01-explore/`. Sorts are personalized
and change hourly, so treat this as a sample.

Top Playing Now, top 25. Concurrent users are at fetch time; "created" is the universe
creation date.

| # | Title (verbatim) | CCU | Genre (Roblox L1/L2) | Created | Max/server |
|---|---|---|---|---|---|
| 1 | Steal An Egg | 1,282,420 | Simulation / Tycoon | 2026-07-25 | 7 |
| 2 | Brookhaven 🏡RP | 216,435 | Roleplay / Life | 2020-04 | 30 |
| 3 | [🌋] Ride A Pet | 173,428 | Simulation / Tycoon | 2026-04-14 | 6 |
| 4 | Blox Fruits | 167,343 | RPG / Action RPG | 2019-01 | 12 |
| 5 | [🏚️] Adopt Me! | 119,460 | Roleplay / Pet Care | 2017-07 | 35 |
| 6 | Murder Mystery 2 | 111,376 | Survival / 1 vs All | 2014-01 | 12 |
| 7 | 99 Nights in the Forest 🔦 | 107,313 | Survival | 2025-03 | 25 |
| 8 | RIVALS | 104,810 | Shooter / Deathmatch | 2024-05 | 40 |
| 9 | Slayers 2 | 76,669 | RPG / Open World | 2024-02 | 1 |
| 10 | [SKY ASSASSIN] Jujutsu Shenanigans | 73,319 | Action / Battlegrounds | 2022-04 | 20 |
| 11 | [👾UPD] Fish It! 🐟 | 71,417 | Simulation / Incremental | 2024-10 | 20 |
| 12 | [⚙️UPD 6] Anime Dice | 67,343 | Simulation / Incremental | 2026-08-15 | 9 |
| 13 | Fisch 🐟 [RACING] | 51,263 | Simulation | 2024-03 | 20 |
| 14 | [CURE] Violence District | 51,203 | Survival / 1 vs All | 2024-10 | 6 |
| 15 | [🥚] Steal a Brainrot | 51,049 | Simulation / Tycoon | 2025-05 | 8 |
| 16 | [Enhance]+1 Loot To Forge | 49,150 | Simulation / Incremental | 2026-08-12 | 8 |
| 17 | +1 Speed Keyboard Escape \| Candy & Chocolate | 45,929 | Simulation / Incremental | 2026-01-18 | 22 |
| 18 | Catalog Avatar Creator | 44,339 | Shopping | 2021-07 | 24 |
| 19 | (WHEELIE STYLE x BIG UPDATE) Drag Drive Simulator | 43,195 | Vehicle Sim | 2025-01 | 25 |
| 20 | The Strongest Battlegrounds | 41,015 | Action / Battlegrounds | 2022-08 | 15 |
| 21 | [✨BONUS] Forsaken | 38,663 | Survival / 1 vs All | 2024-07 | 9 |
| 22 | Sol's RNG [ Summer Event 🏖️] | 35,490 | Incremental | 2023-12 | 20 |
| 23 | Dress To Impress ⭐ | 34,318 | Roleplay / Dress Up | 2023-10 | 13 |
| 24 | Break and Steal an Egg | 32,799 | Simulation / Tycoon | 2026-09-05 | 7 |
| 25 | [CLUBS!] Illegal Soccer | 30,397 | Sports | 2026-05-12 | 8 |

Aggregates [V]:

| Sort | n | Median age | Created <90 days | Created in 2026 | Updated <7 days | Median max/server |
|---|---|---|---|---|---|---|
| Top Playing Now | 97 | 598 d | 26% | 39 | 91% | 16 |
| Top Trending | 89 | 66 d | 57% | 65 | 96% | 16 |
| Up-and-Coming | 41 | 25 d | 98% | 41 | 98% | 8 |
| Top Revisited | 81 | 823 d | 12% | — | 90% | — |

- **Genre mix, Top Playing Now (L1):** Simulation 38, Action 12, Survival 11,
  Roleplay 9, Shooter 6. The L2 leaders are Tycoon 18, Incremental 14 and
  Battlegrounds 10.
- **Genre mix, Up-and-Coming (L2):** Tycoon 19, Incremental 8, plus horror/survival
  ("Anomaly" games, "DON'T LET HIM IN", "7 Days Cat-Sitting").
- **Updates are near-universal:** about 90% of games in every sort were updated within
  7 days. Update cadence is table stakes, not a differentiator.

Platform context:

- **Scale:**
  - 132M DAU in Q1 2026 [D].
  - Q2 2026: 123M DAU, $1.6B bookings and $363M DevEx [D, SEC 8-K].
  - Creators earned $1.7B in the last 12 months [D, RDC 2026].
- **Hit concentration is falling.** The top 10 games' share of hours fell from about
  30% three years ago to about 20% [D, Q2 2026 letter]. The long tail is getting more
  of the time.
- **Record peaks:**
  - Steal a Brainrot: 25.4M CCU, October 2025 [3P].
  - Grow a Garden: 22.3M, August 2025 [3P].
  - 99 Nights: 11.2M [3P].
  - +1 Speed Keyboard Escape: 6.2M, August 2026 [3P].
  - Platform: 47.4M concurrent, 2025-08-23, during a mock "admin war" event between
    two developers [3P].
- **Devices.** About 80% of sessions are on mobile [3P, single secondary source; treat
  as approximate]. GameAnalytics (500+ titles, Aug 2025–Jul 2026) splits players as
  mobile+PC 44%, PC-only 40.8%, mobile-only 11.6%, console 3.7% [3P]. Either way,
  design for touch first.
- **Chat requires age checks** worldwide since January 2026, with chat limited to
  similar age bands [D/3P]. Social mechanics cannot rely on text chat. Successful
  games communicate through actions: stealing, trading UIs, emotes, shared goals.

### A.2 Format classification

**Established (multi-year, evidence: Top Revisited plus long tenure in the top 25)**

- **Social roleplay / life sim:** Brookhaven, Adopt Me, Dress To Impress. Event-driven
  content drops; private-server perks.
- **Anime action RPG:** Blox Fruits, Slayers 2. Level caps, bosses, open seas/worlds,
  collectable powers.
- **Round-based asymmetric (1 vs all):** Murder Mystery 2, Forsaken, Violence District,
  Evade. Lobby → 2–5 minute round with roles → currency → cosmetics → requeue.
- **Battlegrounds fighting:** The Strongest Battlegrounds, Jujutsu Shenanigans.
  Instant PvP sandbox; movesets; the description is just a keybind list.
- **Competitive shooter:** RIVALS (RIA 2026 Best Shooter and Best Studio), Hypershot.
  Duel pads, short matches, keys → skins.
- **Co-op survival / horror:** 99 Nights (Best Survival), DOORS (Best Audio), Dandy's
  World. 2–8 players, emergent roles, visible camp progress.
- **Collection / incremental:** Pet Simulator 99, Bee Swarm, Fisch / Fish It, Sol's RNG.
  Rarity tiers, "1 in N" odds, mutations, indices.

**Current breakout format (2026), strong evidence**

- **Steal-and-defend tycoon.** Lineage: Steal a Brainrot (2025-05) → Steal An Egg
  (2026-07) → a wave of "Steal/Rope/Clone/Shuffle/Break … Egg/Animal" games. Common
  structure [V, from descriptions and thumbnails]:
  1. Train speed on a treadmill.
  2. Enter a biome.
  3. Grab an egg or animal and outrun a guardian or other players back to the base.
  4. Hatch it.
  5. The pet earns money, including offline.
  6. Upgrade the base and treadmill.
  7. Steal from other players' bases.
  8. Rebirth.

  Small servers (5–8) keep everyone's base reachable and the theft personal.
- **"+1 [stat]" incremental obby.** +1 Speed Keyboard Escape won RIA 2026 Best Party
  Game; average session about 9 minutes, about 98% approval [3P]. Its loop is "every
  step = +1 speed → go further → multipliers → rebirth". Clones in Up-and-Coming include
  "+1 Stone Skipping", "+1 Strength for Eggs", "+1 Wings For Eggs", "+1 Web Escape" and
  "+1 Lift Rock for Treasure".
- **Anomaly / short horror-comedy.** Animal Hospital (Anomaly) won Best New Game, People's
  Choice and the Builderman Award at RIA 2026. Animal Daycare (Anomaly), 7 Days
  Cat-Sitting and "WHO FARTED?" follow it.

**Emerging, weaker evidence:** sports with arcade twists (Illegal Soccer, Volleyball
Legends, FIFA Super Soccer); physics/ASMR toys (ASMR Game, Ball VS Ball); dice/RNG gacha
on anime IP (Anime Dice); "Build the Pyramid!" (100-player servers, a co-op incremental
goal).

**One-off viral successes.** These are hits whose *mechanics* spread but whose *peak*
did not last:

- **Grow a Garden.** Built in 3 days by a 16-year-old; 1B visits in 33 days; 22.3M
  peak [3P]. It is absent from today's Top Playing Now top 40 [V].
- **Steal a Brainrot.** 25.4M peak, now about 51k CCU [V]. It is still alive, but the
  meme theme carried the spike.

**Temporary (theme) vs durable (mechanic)** [I]:

- Themes rotate: "brainrot" → eggs/animals.
- The mechanics persist:
  - passive and offline income;
  - visible numbers going up;
  - rarity, mutation and size variants;
  - rebirth;
  - small-server PvP-lite theft;
  - weekly updates.

  An agent should treat theme as swappable data and mechanics as reusable systems.

### A.3 Growth mechanics observed

- **Fast-follow remixing** [V]. The rising tier is dominated by variations of last
  month's hit, created days apart: "Break and Steal an Egg" (2026-09-05) and "Clone to
  Steal Eggs" (2026-09-11) after "Steal An Egg" (2026-07-25). Speed-to-market on a known
  loop is a real strategy, and it is the one agents are best placed to execute.
- **Live events as acquisition.** Admin-abuse events, cross-game "admin wars", concerts
  (bbno$ in +1 Speed Keyboard Escape: 6.36M peak; Bruno Mars in Steal a Brainrot: 12.8M
  peak), and brand collaborations [3P]. These are human and business work, not agent
  work.
- **Off-platform video.** TikTok and YouTube clips of stealing and losing items drove
  Steal a Brainrot [3P]. Designing for *clippable moments* (dramatic theft,
  rare-hatch reveals) is a design input.
- **In-game referral loops** [V, descriptions]:
  - "Like the game and join the group for a FREE Animal!"
  - "Roblox Plus players get +10% Cash"
  - "UPDATES EVERY SATURDAY!"
  - codes posted to the group or social channels.

---

## B. Successful game anatomy

### B.1 Core loops (reverse-engineered; [V] from live descriptions/thumbnails, [3P] reviews)

| Format | Loop | First meaningful action | First reward | Short-term goal | Medium | Long | Social/competition | Randomness |
|---|---|---|---|---|---|---|---|---|
| Steal tycoon | train → raid biome → escape → hatch → passive cash → upgrade → steal/defend → rebirth | seconds (treadmill next to spawn) | first egg within ~1 min [I] | next egg tier / speed gate | base expansion, biome unlocks | index completion, secret/mythic, rebirths | theft from/of other players in a 5–8 server | hatch rarity, mutations, sizes |
| +1 incremental obby | move → +1 stat per step → go further → multiplier → rebirth | immediate (walking *is* the action) | the first +1 counter tick | next zone/wall | multipliers, pets | rebirth tiers, world N | racing friends, leaderboards | low |
| Round asymmetric | lobby → role assignment → 2–5 min round → coins → crates/skins → requeue | <1 round wait | end of the first round | win as role | knife/skin collection | rare cosmetics, trading | 1 vs all, roles | role assignment, crates |
| Battlegrounds | spawn → fight anyone → kills/ult → character unlocks | immediate | first KO | combo mastery | unlock movesets | mastery/status | open PvP | low |
| Co-op survival | gather → craft → defend at night → expand camp → survive N nights | <1 min | first craft | survive tonight | camp upgrades, classes | reach night 99 | role division with friends | events, loot |
| Collection/fishing/RNG | act (cast/roll) → item with rarity → sell/index → better tool → new area | seconds | first catch/roll | next rod/dice | islands, luck upgrades | 1-in-millions variants | trading, showing off | core |
| Social RP | spawn → pick house/vehicle → roleplay | immediate | none required | decorate | events | identity | everything | events |

Repeated patterns:

- **Time to first action is close to zero.** The successful games put the core verb at
  spawn: a treadmill, a duel pad, walking itself. Roblox's own guidance is to "get to
  the fun quickly"; players decide "within minutes" [D].
- **The title is the tutorial.** "+1 Speed Keyboard Escape" and "Steal An Egg" explain
  the verb and the object [3P/V].
- **Numbers go up visibly and constantly.** "$89,121Sp/s", "1 in 9,342,584",
  "+1T": big numbers are in the thumbnails themselves [V].
- **Offline progress plus rebirth** turns a short-session game into a return habit.
  "MONEY GENERATES WHILE YOU ARE OFFLINE" appears verbatim in several descriptions [V].
- **Front-loaded progression.** Roblox recommends "keeping thresholds low for a
  player's early levels", free starter resources, short/mid/long goals, and ending
  onboarding on a "moment of joy" [D].

### B.2 First-session (FTUE) patterns [D, 3P, I]

- **What the player sees first:** their avatar next to the core interactable, a HUD
  with a currency counter, and one obvious next step: a glowing path, bouncing arrow,
  or highlighted button.
- **Tutorial style:**
  - contextual "just-in-time" tutorials;
  - timed hints (Roblox's example highlights a button after 11 s of inaction);
  - in-world signs, beams and arrows;
  - spotlighting with dimmed surroundings [D].
- **Friction is near zero.** No menus before play, no story, no forced character
  creation. Shops appear *after* the first reward.
- **Rewards shown early:** starter currency, the first upgrade affordable within
  seconds, a popup on the first rare hatch.
- **Measure it:** `AnalyticsService:LogOnboardingFunnelStepEvent` for each step;
  dashboards show the drop-off per step. Hourly granularity, two years of history [D].

### B.3 Retention mechanisms, and why each is used

| Mechanism | Purpose | Observed in | Caution |
|---|---|---|---|
| Daily rewards / streaks | daily habit (D1/D7) | most simulators | weak without a core loop |
| Offline earnings | reason to return; makes short sessions feel productive | steal tycoons, Anime Dice | inflates the economy |
| Rebirth / prestige | resets the short loop with a multiplier; long tail | nearly all incrementals | needs a felt multiplier |
| Collections / index | long-term goals; completionism | Fisch, steal tycoons ("Animal Index") | needs rarity design |
| Rarity / mutation / size variants | discovery and variable reward | Fish It (1M+ variations), Sol's RNG | chance-based paid items carry policy risk (see §18) |
| Weekly updates / limited events | content cadence; return spikes | "UPDATES EVERY SATURDAY", seasonal tags | human/live-ops cost |
| Group / like rewards | social graph, notification channel | most rising games | — |
| Ranked / leaderboards / win streaks | competition | RIVALS, Volleyball Legends | needs population |
| Trading | economy, social status | MM2, Adopt Me | scams; real-money trading (Grow a Garden) |
| Visible base / camp | social proof | 99 Nights, tycoons | — |
| Private servers | groups, roleplay | Brookhaven | — |

### B.4 Art, maps, audio, monetization, updates: short findings

- **Art:**
  - Simulators use bright, saturated, toy-like blocky models plus the
    default-avatar look.
  - Horror and anomaly games use dim interiors and one memorable creature.
  - Anime games use licensed-adjacent stylized characters.
  - Low-poly and blocky art is the norm, which helps generation: low triangle counts,
    flat colours [V].
- **Maps:**
  - Simulators and tycoons use a hub with radiating biomes gated by a stat.
  - Round games use small arenas with lobbies.
  - Shooters use three-lane layouts with mirrored spawns [D].
  - Co-op survival uses a central camp with radial exploration.
- **Audio:** UI clicks and reward stingers are as important as music. +1 Speed's
  "clicky-clacky ASMR" is cited as a core reason it works [3P]. DOORS won Best Use of
  Audio.
- **Monetization:**
  - game passes (2× cash, VIP, auto-collect);
  - developer products (speed, luck and income boosts, skips, crates);
  - subscriptions;
  - private servers;
  - rewarded video ads ($6–12 eCPM, [3P]);
  - Managed Pricing (price optimization plus regional pricing). Price optimization
    gives about +4% average earnings; regional pricing +4–10% Robux spend [D].
  - Criticism tracks the most aggressive pay-to-win setups: Steal a Brainrot, Grow a
    Garden [3P].
- **Updates:** the title tag is the update channel ("[⚙️UPD 6]", "[🌋]", "[CURE]",
  "(WHEELIE STYLE x BIG UPDATE)"). So are the first description line ("OUT NOW: …"),
  thumbnail refreshes, and Roblox's Events API / notify button [V/D].

---

## C. Titles, descriptions, store presentation

### C.1 Titles [V, n=281; descriptive statistics only, no causal claims]

| Feature | All (281) | Top Now top 25 | Up-and-Coming (41) |
|---|---|---|---|
| Median length | 21 chars, 3 words | 20 chars, 2 words | 19 chars, 3 words |
| Contains emoji | 38% | 44% | 17% |
| Leading `[tag]`/`(tag)` | 31% | 44% | 15% |
| Update/event words (UPD, NEW, EVENT…) | 10% | 16% | 5% |
| Digit in title (excluding tags) | 12% | 20% | 24% |

Recurring structures:

1. **Verb + a/an + Noun**: "Steal An Egg", "Ride A Pet", "Kick a Lucky Block",
   "Rope an Animal", "Shuffle an Egg", "Steal A Car". This is the 2026 dominant form.
   The title states the verb.
2. **+1 Stat + Noun/Goal**: "+1 Speed Keyboard Escape", "+1 Strength for Eggs".
3. **Noun for Animals/Eggs** (remix suffix): "Motorcycle for Animals", "Sail For Eggs",
   "Survive Lava for Animals".
4. **Brand name, short and proper-noun**: "RIVALS", "Forsaken", "Evade", "DOORS",
   "Fisch". This form belongs to established games that grew a brand.
5. **[Tag] Brand**: an update/event tag in front of an established name ("[🏚️] Adopt
   Me!", "[CURE] Violence District"). Roblox's 2020 metadata PSA says to keep titles
   consistent and avoid emoji spam [D]. In practice, top games use exactly one tag slot,
   rotated per update.

Inference [I]:

- New games use **descriptive verb titles**: search, plus instant comprehension in a
  feed.
- Established games use **brand plus a rotating tag**: returning players get the
  signal "something new".
- New games carry fewer tags because there is no update to announce yet.

Title metrics against conversion are *not* available publicly. There is no title
A/B test; icon testing is a requested feature [D]. Any correlation from this sample
would be spurious.

**Policy** [D]:

- Title, description and thumbnails must be rated All Ages or 9+.
- No "Roblox" in titles.
- Thumbnails and videos must not misrepresent the gameplay.

### C.2 Descriptions [V]

- **Median length** is 455 chars overall and 357 for Up-and-Coming. The median
  description uses 5–7 emoji.
- **The new-game template** is near-identical across rising games:

  ```
  🥚 Welcome to <Title>!
  How to Play:
  <emoji> <verb phrase>          (5–9 bullets, the core loop in order)
  💤 Your <pets> earn Cash even while OFFLINE!
  ♻️ Rebirth to …
  👍 Like the game and join the group for a FREE <item>!
  🎮 Supports Desktop, Console, Mobile, and Tablet
  [UPDATES EVERY SATURDAY!] [ROBLOX PLUS PLAYERS GET +10% Cash] [Tags: …]
  ```
- **Established games** lead with the latest update ("OUT NOW: 🧲 Magnet + 🏝️ Sea 1"),
  then the premise, then the role/controls list (MM2, Jujutsu Shenanigans), then FAQ and
  private-server perks.
- **Atmospheric minimalism also works** for strong brands with a horror tone.
  99 Nights' whole description is: "Build a camp with friends. Something is watching
  you."
- **Share of descriptions asking for a like/favourite:**

  | Sort | Asks for like/favourite |
  |---|---|
  | All 281 | 34% |
  | Trending | 48% |
  | Up-and-Coming | 44% |

- **Share mentioning a group/community:**

  | Sort | Mentions group/community |
  |---|---|
  | All 281 | 27% |
  | Top 25 | 44% |
- **External social links are rare (about 1%).** "Check my profile" is used instead.

What players need before deciding:

- the verb;
- the reward fantasy (rarity, money numbers);
- that friends can play;
- device support;
- that the game is alive (update line).

Descriptions serve conversion and returning players more than search. The first
sentence matters for search snippets [D].

### C.3 Icons and thumbnails [V: visual review of the top 16 plus 8 rising games at 256 px, 64 px, and 16:9]

Conventions observed:

- **Rising simulator thumbnails share one house style:**
  - a rendered, posed default-style avatar with an exaggerated expression (strain,
    shock, grin);
  - the avatar performs the title verb on the title object: carrying the egg, roping
    the T-rex, punching the wall;
  - a saturated sky-blue and grass-green ground;
  - giant outlined numbers with rarity labels ("Giraffe Egg MYTHIC $64,99M/s",
    "1 in 50Qa");
  - a red "YOU" arrow and "!!" or "?..." marks.

  Compositions put the character at about 1/3 width and a single large hero object.
  This is professional GFX rendering (Blender-style lighting on Roblox rigs), not
  in-game screenshots.
- **Established brands are logo-forward** (BROOKHAVEN, ADOPT ME!, BLOX FRUITS) or a
  single symbol (MM2's knife "2", RIVALS' two red figures, Jujutsu Shenanigans' bare
  noob head). These read best at 64 px.
- **Horror** uses one creature face on black (99 Nights), or a faux "found footage"
  screenshot with a red circle (7 Days Cat-Sitting).
- **Readability at small size.** The busy multi-number simulator icons degrade at 64 px.
  Logo and single-subject icons survive [V].
- **Official specifics:**
  - Thumbnails are 16:9, ideally 1920×1080, with nothing essential at the bottom
    (covered by player-count metadata).
  - Icons are at least 512×512 square.
  - Personalization uses up to 5 thumbnails, with a hourly multi-armed bandit on
    qualified play-through rate (qPTR). Average +12% qPTR lift, some +56%.
  - Do not restart tests within 7 days. Make variants *different*: combat vs
    exploration vs character.
  - Thumbnails are now API-manageable (`thumbnail-personalization-api`, 2026-08-24).
    Icons are **not** writable by the API yet [D].
- **Production tools:**
  - The traditional pipeline is Studio rig export → Blender pose/light/render →
    Photoshop composite, at 30–120 minutes per thumbnail [3P].
  - AI thumbnail services exist (VizzBees, RoThumbs, Thumbmagic) [C].

What is automatable [I]:

- **Composition and copy:** fully automatable.
- **Rendering:**
  - in-engine via the `screen_capture` camera override plus posed rigs [V], or headless
    Blender;
  - an image model can then stylize or composite;
  - text and number overlays are deterministic.
- **Selection:** let Roblox's bandit choose by uploading 5 distinct variants through
  the API.
- **Hard:**
  - matching the polished GFX style consistently;
  - avoiding misrepresentation (generated art must show real game content);
  - the icon, which has no API.

---

## D. Design workflows

What experienced teams do [D, 3P]:

- **Write a GDD before code** for systems, economy and progression.
- **Greybox before art.** Roblox's own curricula teach greyboxing playable areas and
  three-lane layouts.
- **Ship a core-loop prototype fast and iterate on live data.** Grow a Garden was built
  in 3 days and then updated every 1–2 weeks. Configs change values live without server
  restarts; Experiments A/B test them, reporting results such as +50% payer conversion
  and +12.5% playtime [D].

| Decide up front (spec) | Let emerge (prototype + data) |
|---|---|
| Core verb, loop, session shape, server size, target devices | Exact costs, reward rates, drop odds |
| Progression axes (stat, rebirth, collection) and their caps | Pacing of the first 5 minutes |
| Economy sources/sinks (the topology) | Starter currency amount (Roblox: A/B test it) |
| Monetization *surfaces* (what can be bought, never pay-to-own-others) | Prices (Managed Pricing) |
| Social model (co-op / PvP-lite / competitive), anti-grief rules | Matchmaking parameters |
| Data schema (what persists) | UI layout details |
| Tone, theme, title verb | Which thumbnail wins |

The agent can own [I]:

- turning a concept into a systems decomposition;
- choosing from proven formats;
- economy topology and first-pass curves;
- implementation;
- tests;
- the FTUE script;
- presentation drafts.

A human should own:

- theme and IP choices, including licensed or meme content and its legal risk;
- the monetization ethics line;
- final "is this fun" calls;
- budget spend;
- publishing;
- community management and live events.

---

## E. Programming and backend

### E.1 Platform services the agent must handle

| Area | Current guidance | Agent note |
|---|---|---|
| Client/server | Server authoritative; remotes validated server-side. **Server Authority** (prediction + rollback, blocks speed/teleport/noclip without custom anti-cheat) has been fully released for all creators [D, 2026] | Default new projects to Server Authority where physics matters; leave remote validation to code patterns |
| Persistence | DataStoreService with session locking; ProfileStore is the community standard [3P] | Studio DataStores need a published place plus API access; tests should mock |
| Cross-server | MemoryStore (queues, sorted maps), MessagingService | Not testable in Play Solo; needs a published-place lane |
| Teleports | TeleportService (lobby → round places) | Multi-place universes complicate agent workflows; prefer single-place designs early |
| Purchases | MarketplaceService.ProcessReceipt (idempotent grant), gamepass checks | Testable only partially in Studio; the receipt handler must be unit-tested |
| Streaming | StreamingEnabled default; WaitForChild on client | Tests must not assume a replicated far-away world |
| Live config | ConfigService + Experiments, Open Cloud-manageable [D] | Put every tunable in Configs from day 1; it unlocks the post-launch loop |
| Analytics | AnalyticsService funnel/economy/custom events [D] | Instrument automatically at generation time |
| Text/voice/NPC AI | TextGeneration API (beta), Text-to-Speech (full release Aug 2026; 10 voices; 300 chars; rate = 1 + 6×CCU/min), Speech-to-Text (beta) [D] | Runtime NPC dialogue is now native |
| 4D generation | `GenerateModelAsync` (beta, Feb 2026), runtime functional models [D] | Credit/cost and moderation implications |

### E.2 Libraries

The consensus stack, community-sourced [3P]:

- **Tooling:** Rojo (sync, now with syncback), Wally/pesde (packages), Selene (lint),
  StyLua (format), Rokit (toolchain), luau-lsp, Lune (standalone Luau runtime).
- **Data:** ProfileStore.
- **Networking:** ByteNet (typed buffer networking).
- **UI:** React-lua (Roblox-maintained), Fusion, Vide.
- **ECS:** Jecs/Matter.
- **Testing:** Jest-Roblox (runs in Roblox, including via Open Cloud Luau Execution);
  TestEZ is archived (Sep 2024).
- **Deprecated:** Knit (archived), Roact (unmaintained).

Fit for agents [I, plus our bench experience]:

| Use | Avoid by default |
|---|---|
| Plain Luau services + ModuleScripts, typed (`--!strict`) | Heavy DI frameworks (Knit-style) – extra indirection, archived |
| ProfileStore (well-known API, widely represented in training data) | Hand-rolled DataStore code |
| A thin remote wrapper with server-side validation, or ByteNet only when bandwidth matters | ECS (Jecs/Matter) unless the game needs thousands of entities; agents misuse ECS patterns |
| UI: code-built instances for simple HUDs (what blox does today); React-lua for big UIs | Fusion (fast-changing API) |
| Jest-style specs (blox's own runner is API-compatible in spirit) | — |

Recommendation: ship a **blessed module set** inside blox's scaffold: data, remotes,
purchases, analytics, configs and UI primitives. Then agents compose rather than
reinvent, and the tests for those modules come for free.

---

## F. Studio automation surfaces

| Surface | Control | Observe | Play mode | Modify instances | Run scripts | Runtime state | Screenshots | Errors | Restart | Autonomy-ready? |
|---|---|---|---|---|---|---|---|---|---|---|
| **Built-in Studio MCP** (26 tools; `studio_id` on every call since 2026-08-19) | yes | yes | start/stop; server and client datamodels reachable [V] | yes | `execute_luau` | yes | `screen_capture` with camera override [V] | `get_console_output`; LogService via Luau [V] | play restart yes; no place reload | **Yes, with a harness** (blox's session/luau/play layers) |
| **blox tool layer** (13 tools) | sync, tests, playtest, explore, screenshot, task | typed logs, mapped errors | Play Solo | builders | `run_luau` | yes | yes | file:line mapping | yes | Yes (bench 3/3 core, 16/16 checks [V]) |
| **StudioTestService** (plugin security) | `ExecutePlayModeAsync`, `ExecuteMultiplayerTestAsync(n≤8)`, `AddPlayers`, `EndTest` [D] | test result return value | yes, multi-client | — | via test args | yes | — | — | yes | Needs a plugin (the blox dock plugin can host it) |
| **VirtualInput** (`SendKey`, `SendMouseButton`, `SendTextInput`…) | "processes input identically to real hardware"; powers Assistant playtesting [D] | — | yes | — | — | — | — | — | — | Yes for UI/input-path tests; security context undocumented — probe |
| **StudioDeviceSimulatorService** (`SetDeviceAsync`, `SetOrientationAsync`) [D] | device/resolution | — | — | — | — | — | combine with screenshots | — | — | Yes: mobile layout checks |
| **MicroProfiler + LibMP API; Scene Analysis** [D] | capture | per-frame timings, triangles, memory | yes | — | — | yes | — | — | — | Partially (dumps are large; 1 frame ≈ 1 MB JSON) |
| **Rojo / Argon** | file↔Studio sync (Argon two-way) | — | — | scripts/models | — | — | — | — | — | Human Connect click for Rojo; blox replaced it with push-via-MCP [V] |
| **Open Cloud Luau Execution** | run Luau against a *published* place version, ≤5 min [D] | return values, logs | server-only run, no players | in that session | yes | yes | no | yes | n/a | CI lane: headless and deterministic; Jest-Roblox and OpenGameEval use it |
| **Open Cloud Place Publishing** | `POST /universes/v1/{u}/places/{p}/versions` (.rbxl/.rbxlx) [D] | version number | — | whole place | — | — | — | — | — | Yes, but outward-facing: human gate |
| **Community MCPs** (EL4CTEO/Codder13 rbx-studio-mcp, weppy, rbxsync, rodeo) | batched undo, CreateVirtualInput input, multi-agent port sharing, live-place `execute_luau` [C] | — | some | yes | yes | yes | yes | yes | — | Ideas worth copying (see §R) |

Hard limitations [D/V]:

- No place reload or "restart Studio" API.
- Popups and panels need humans.
- Studio auto-update breaks `mcp.bat`; blox resolves the executable instead [V].
- Assistant playtests are LLM-judged and give false passes.
- Fine-grained per-client control in multiplayer tests is "coming soon".

---

## G. AI game-development landscape

| System | What it is | Studio link | Agent controls | Agent observes | Human needed | Reliability evidence | Adopt | Avoid |
|---|---|---|---|---|---|---|---|---|
| **Roblox Assistant** (first-party) | Planning mode (editable plan, checkpoints), playtest subagent, data-model search subagent, skills (device sim, scene analysis, docs), mesh/material/procedural generation [D] | native | everything in Studio | logs, screenshots, input sim | approvals; daily caps | OpenGameEval (117 evals): best model 50% Pass@1 on the 87-eval set [D]. Users report repeat-loops [D replies] | plan → act → playtest structure; skills | LLM-judged pass/fail |
| **Roblox Build** (mobile prompt → game, alpha) + **Scene Generator** (later 2026) | prompt → functional scene/game; 9,000 games published in alpha, 71% by people new to Studio [D] | Build↔Studio bridging announced | — | — | — | demo: a theme park in about 14 minutes [3P] | — | competing on raw prompt-to-scene |
| **Cube 3D / 4D** | text → mesh; `GenerateModelAsync` multi-part functional objects (beta); new models: 4K PBR, normal maps [D] | Studio + runtime API | prompt + schema | result | credits | official; quality varies [3P] | first-choice prop generator (in-platform, no import step) | expecting art-direction consistency |
| **Lemonade.gg** | web app + plugin; Luau/UI generation, auto-sync, image → UI, Playtest Agent beta [C/3P] | plugin | scripts, UI | claimed playtest | yes | mixed Trustpilot reviews [3P] | multimodal UI input | closed; unverified QA |
| **ZeroScript** (OSS) | browser extension driving free chat UIs to the Studio MCP via a local bridge; place-saved project memory [3P] | Studio MCP | MCP surface | MCP surface | prompting | fragile text parsing (its own README) | persistent project memory in-place | scraping chat UIs |
| **Superbullet** | "one prompt to a full game", 1,000+ system templates, project RAG [C] | plugin | — | — | — | none public | templates + retrieval | — |
| **Ropilot, Rebirth (~50K users [C]), BloxBot (Claude/OpenCode + Studio MCP), HyperDevs (86 MCP tools, image/3D/animation pipeline) [C]** | Studio agents / desktop apps | MCP/plugin | varies | varies | varies | vendor-only | HyperDevs-style chained asset pipeline with budgets | marketing claims as facts |
| **Generic coding agents** (Claude Code, Codex, Cursor, Gemini CLI) via Studio MCP Quick Connect [D] | — | MCP | MCP | MCP | — | our bench: raw MCP + legacy prompt 0/3; with the blox tools 3/3 [V] | — | — |
| **Blender MCP** (ahujasid, ~28k★; official Blender Lab MCP v1.0.x, Apr–Sep 2026, Blender ≥ 5.1) | Python-API control, viewport screenshots, asset/library search, AI 3D (Hunyuan3D/Tripo/Rodin) [3P/D] | — | full bpy | screenshots, datablocks | low for scripted ops | community: main-thread freezes on downloads; timeouts [3P] | headless bpy scripts for normalization | interactive GUI dependence |
| **Text-to-3D** (Meshy, Tripo, Rodin, Hunyuan3D) | text/image → textured mesh; low-poly/remesh, auto-rig, FBX/GLB [C] | export → import | prompt | renders | curation | reports: Tripo fast topology, Meshy fuller pipeline [3P] | concept → mesh for hero props | dense topology, inconsistent style |
| **Animation** (Roblox Animation Capture beta: video → R15; text→R15: Bloxlab, NoCapMocap, UGCraft [C]; RBXMonkey Blender↔Studio v3.0.1, Aug 2026) | — | rbxmx KeyframeSequence / Studio | prompt/video | preview | review | vendor | text/video → R15 for emotes, NPC idles | combat timing |
| **Audio** (Roblox library; ElevenLabs SFX V2: 48 kHz, ≤30 s, loops, commercial on paid plans [C]; Roblox TTS) | — | Open Cloud audio upload (≤20 MB, ≤7 min; 2,000/30 days if ID-verified) [D] | prompt | — | licensing check | — | SFX generation + upload | copyrighted music |
| **OpenGameEval** (Roblox, OSS) | eval harness: `setup`/`check_scene`/`check_game` per task, run via an Open Cloud eval API [D] | cloud | — | checks | — | — | its eval format mirrors blox bench; consider cross-running | — |

Take-aways [I]:

1. Everyone converges on the Studio MCP; Roblox is absorbing the "connect AI to
   Studio" layer.
2. Nobody public ships deterministic, game-level verification plus multiplayer tests.
3. Nobody ships an end-to-end *presentation and live-ops* loop.
4. Asset pipelines exist as vendor apps but without provenance or budget enforcement.

---

## H. 3D, environment, animation, assets, audio

### H.1 Practical asset pipeline for an agent [I, grounded in D/V]

Ordered by reliability:

1. **Code-built geometry (world-as-code).** Parts, unions, terrain API, procedural
   models. This is the most reliable: diffable and testable, and blox already has it
   (`world/*.luau`). Ideal for greyboxing, obbies, arenas and blocky simulator worlds,
   which is the dominant art style.
2. **Creator Store.** Reuse via `search_asset`/`insert_asset` [V].
   - **Licence:** Creator Store assets may be used on Roblox; attribution is encouraged,
     not required [D].
   - **Security risk:** free models can hide scripts and backdoors. The agent must
     strip or inspect scripts on insert and record provenance.
3. **Roblox Cube / `generate_mesh` / `generate_material` / procedural model.**
   In-platform with no import step; costs credits. blox gates and caches these
   already [V].
4. **External text/image-to-3D → headless Blender → Open Cloud upload.**
   1. Generate with Meshy or Tripo (FBX/GLB).
   2. Run a `blender -b --python normalize.py` step: scale to studs, pivot at base,
      decimate to a triangle budget, merge materials, bake textures, export FBX.
   3. Upload with the Open Cloud Assets API (fbx/gltf/glb).
   4. Insert by asset id.

   Limits:
   - 20k triangles per MeshPart; target ≤10k (lower for mobile) [3P/D].
   - Uploaded models need moderation.
   - Externally edited `.rbxm` may fail [D].
   - Style consistency across assets is the unsolved part: use one style prompt plus
     reference images, and generate kits in one batch.
5. **Characters and rigs.** Use R15 and Roblox avatars. Custom rigged creatures are
   the hardest category: auto-rig, then Animation Capture or text-to-R15. Keep human
   review here.

### H.2 Maps and level design

Generation is feasible today with code and modular placement, the hybrid route [I]:

- **Layout from a format template.** Hub + biomes gated by stat; three-lane arena;
  camp + radial POIs; linear obby stages.
- **Kit placement.** Greybox from the layout graph → kit placement → terrain fill →
  lighting preset.

Automated map evaluation, all scriptable in Luau via `run_luau`/playtest [I]:

- **Navigation:** `PathfindingService:CreatePath` between spawn and every POI. Report
  unreachable POIs and path lengths, i.e. traversal time at WalkSpeed.
- **Spawn safety:** raycasts/region checks for hazards and enemy sightlines within
  radius R of spawns.
- **Sightlines and chokepoints:** a raycast grid; a heat-map of visible area per cell.
- **Performance:** part/triangle counts per region, Scene Analysis, MicroProfiler
  capture during the playtest.
- **Visual:** screenshots from fixed cameras plus a VLM rubric. This is advisory, not a
  gate.

### H.3 Animation

- **Automatable:**
  - procedural animation in code (tweens, Motor6D/IK controls, AnimationConstraints);
  - environment animation;
  - UI motion;
  - emotes and NPC idles from text/video tools [C];
  - Animation Capture from video [D].
- **Needs a human:** combat animation feel (anticipation, hit-stop), custom creature
  rigs.
- **Engine help:** Roblox is moving default avatars to motion matching with root
  motion and object interaction (RDC 2026) [D]. That reduces the custom locomotion
  work.
- **Gap:** animation upload via Open Cloud. `.rbxm` animations can be uploaded since
  Oct 2025 [D], but the official Blender plugin notes the animation endpoint is not
  supported for its flow [3P]. Treat it as "probe before relying on it".

### H.4 Audio

The practical agent workflow [D/C]:

1. Search Roblox's licensed audio library via `search_asset` first.
2. Generate missing SFX and loops with ElevenLabs.
3. Upload through Open Cloud. Limits: 2,000/30 days if ID-verified, ≤20 MB, ≤7 min.
4. Wire SoundGroups/AudioPlayer.

Notes:

- Runtime voice for NPCs uses the built-in TTS.
- Copyrighted music is disallowed.
- Music generation is a licensing judgment, so a human approves it.

---

## I. UI/UX

- **Common layouts** [V/I]:
  - left rail of round icon buttons (Shop, Pets, Rebirth, Index, Codes);
  - top-centre currency counters with `+` buy buttons;
  - bottom-right action buttons on mobile;
  - big modal shops with tabs;
  - toast stacks for rewards;
  - full-screen reveal for rare hatches.
- **Mobile first** [3P/D]:
  - Size with Scale, not Offset.
  - Touch targets ≥44 px with spacing.
  - Respect `ScreenInsets` / the safe area.
  - Branch on `LastInputType`, not device flags.
  - Controller: gamepad selection paths (`GuiService.SelectedObject`).
- **AI-generatable:**
  - code-built UI (blox does this) and image → UI (blox `--image`; Lemonade has it
    too) [V/C];
  - deterministic UI lint via client-context Luau, which **does not need vision**:
    - elements outside the viewport or safe area;
    - overlaps;
    - touch targets below 44 px at a phone resolution set through
      StudioDeviceSimulatorService;
    - TextScaled/TextFits failures;
    - unreachable gamepad selection.
- **Needs visual iteration:** visual polish and style match. Screenshots plus a VLM
  are advisory.

---

## J. Playtesting and automated QA

The loop **Build → Play → Observe → Diagnose → Modify → Replay**:

| Step | Today in blox [V] | Available platform piece [D] | Gap |
|---|---|---|---|
| 1 Start game | `playtest` / `play` (Play Solo) | `StudioTestService.ExecutePlayModeAsync` | — |
| 2 Join server, multiple players | single player | `ExecuteMultiplayerTestAsync(n≤8)`, `AddPlayers` (plugin) | **multiplayer lane** |
| 3 Control character | Studio MCP `character_navigation`, keyboard/mouse input tools; server-side `Humanoid:MoveTo` in probes | VirtualInput, PathfindingService | scripted "bot behaviours" library |
| 4 Perform actions | probe Luau + clicks (`inputs` with `click` targets) | VirtualInput | — |
| 5 Observe | server/client probes, typed logs, screenshots | Scene Analysis, MicroProfiler | perf capture |
| 6 Detect expected behaviour | repo tests (`tests/*.spec.luau`, edit/server/client) + task criteria | — | **game-feel metrics** (time to first action/reward) |
| 7 Capture screenshots/video | screenshots | — | video (no API; OS capture on Windows only) |
| 8 Read runtime errors | LogService typed, file:line mapped | — | — |
| 9–11 Diagnose, modify, repeat | agent | — | — |
| Bots at scale | — | RDC: "AI-powered testing without real players", "hundreds of intelligent NPCs" (announced, no API yet) [D/3P] | watch |

Principle, confirmed by Roblox's own false-pass disclosure and our baseline: the
**completion signal must be deterministic checks running in the engine**. LLM
observation finds *candidates*; tests decide.

Additions specific to game quality [I]:

- **FTUE probe.** Spawn a fresh player with an empty profile. Measure, in seconds:
  - time until the first core-verb event;
  - time until the first currency gain;
  - time until the first purchase prompt;
  - number of modal UIs shown before control.

  Compare against format budgets, e.g. core verb ≤10 s, first reward ≤60 s.
- **Loop soak.** A bot repeats the core loop for N minutes. Assert:
  - the economy stays within the curve envelope;
  - no errors;
  - memory is stable.
- **Multiplayer invariants.** With 2–8 clients:
  - theft only from the intended targets;
  - no duplicated items;
  - correct ownership after leave/rejoin;
  - DataStore mock consistency.
- **Device matrix.** Phone portrait, phone landscape, tablet, 1080p: UI lint and a
  screenshot for each.

---

## K. Balancing and analytics

- **Benchmarks to target** (GameAnalytics, 500+ titles, 4.76B sessions) [3P]:

  | Metric | p50 | p75 | p90 |
  |---|---|---|---|
  | D1 retention | 10.3% | 12.9% | 15.9% |
  | D7 retention | 1.6% | 2.3% | 4.5% |
  | D30 retention | 0.5% | — | 1.5% |
  | Session length | 9.8 min | — | 14.7 min |

  Payer conversion is about 3.8%. ARPPU per game: p50 $0.70, p90 $2.33.
- **Roblox data available:**
  - Creator Analytics: retention, engagement, monetization, acquisition, benchmarks at
    100+ DAU.
  - Funnel, economy and custom events, hourly.
  - Experiments with minimum-detectable-effect calculation.
  - **The Analytics Query API** (`analytics-query-api/v1/universes/{id}/metrics`,
    scope `universe.analytics:read`; data lags 5+ hours). It makes the post-launch loop
    agent-accessible [D].
- **Pre-launch balancing** [I]:
  - Model the economy as data: sources, sinks, costs, multipliers, rebirth formula.
  - Run an **offline simulator** (Lune or TS) of player archetypes over 1h/1d/7d to
    produce curves: time-to-unlock per tier, inflation, rebirth intervals.
  - Agents are good at this. It is pure computation and it catches the "rebirth
    unreachable" or "tier 3 in 30 seconds" class of bugs before any playtest.
- **Post-launch.** The agent reads funnels (onboarding drop-off step), economy
  sources/sinks, and retention by cohort. It proposes Config changes or Experiments; a
  human approves the ones that touch monetization.

---

## L. Monetization

- **Surfaces:**
  - game passes (permanent: 2× cash, VIP, auto-collect, extra storage);
  - developer products (boosts, luck, skips, crates/eggs, revive);
  - subscriptions;
  - private servers;
  - rewarded video ads;
  - cosmetics.
- **Discovery now rewards sustainable monetization together with retention** [D].
  Roblox's own guidance: optional, value-driven purchases, placed at natural
  progression moments, transparent [D].
- **Design rules for an agent** [I]:
  - Never sell power over other players in PvP-lite formats beyond convenience. Theft
    games are the most criticized [3P].
  - Show odds for chance-based items.
  - Make everything purchasable also earnable, except cosmetics and convenience.
- **Automatable:**
  - ProcessReceipt / pass checks / product catalogue as code, with tests;
  - creating products and passes via Open Cloud (where the API supports it);
  - pricing via Managed Pricing (opt-in, human).

---

## M. Possible today vs speculative

| Capability | Status |
|---|---|
| Write/modify gameplay code, sync, run in-engine tests | **Proven** (our bench 3/3, 16/16 live checks [V]; OpenGameEval top ≈50% Pass@1 on harder tasks [D]) |
| Code-built greybox worlds, obbies, arenas | **Proven** [V] |
| Single-player observed playtests with probes, typed logs, screenshots | **Proven** [V] |
| Multiplayer automated tests (≤8 clients) | **Possible with engineering** (StudioTestService via plugin) |
| UI built from code; image → UI | **Proven** (blox P3 [V]; Lemonade [C]) |
| Deterministic UI lint across devices | **Possible with engineering** (DeviceSimulator + client Luau) |
| FTUE/loop metrics from bot playthroughs | **Possible with engineering** |
| Economy simulation before launch | **Possible with engineering** (pure computation) |
| Prop generation in-platform (Cube, procedural models) | **Proven** for simple props; **experimental** for style-consistent kits |
| External text-to-3D → Blender normalize → upload | **Possible with engineering**; quality and consistency **experimental** |
| Rigged custom characters + good combat animation | **Experimental** |
| Emotes/idles from text or video | **Experimental** (vendor tools; Animation Capture beta) |
| SFX generation + upload | **Possible with engineering** (licensing checks) |
| Music generation | **Experimental** (licensing ambiguity) |
| Icon/thumbnail variants + title/description from templates | **Possible with engineering**; matching top-tier GFX polish is **experimental** |
| Publishing, thumbnail personalization, configs, experiments via Open Cloud | **Possible with engineering** (APIs exist; human approval by policy) |
| Reading analytics and proposing changes | **Possible with engineering** (Analytics Query API, Aug 2026) |
| "Is it fun?" judgment; trend picking with confidence | **Not currently practical** autonomously; the agent can rank candidates on evidence, a human decides |
| AI bot players that behave like real players at scale | **Not currently practical** externally (Roblox announced internal NPC testing; no API) |
| Live events, influencer/brand deals, community management | **Not practical** (human/business) |

---

## N. Tool and technology matrix

| Tool | Purpose | AI-accessible | Integration | Roblox-compatible | Automation potential | Reliability | Cost | Notes |
|---|---|---|---|---|---|---|---|---|
| Studio MCP (built-in) | Studio control | yes | MCP stdio | native | high | good with harness [V] | free | `studio_id` on every call; attach races |
| blox tools (sync/tests/playtest) | verified build loop | yes | MCP + CLI | native | high | 3/3 bench [V] | — | core asset |
| StudioTestService | multiplayer tests | via plugin | dock plugin ↔ blox | native | high | GetTestArgs nil bug [D] | free | build next |
| VirtualInput | real input | probe | Luau/plugin | native | high | official (powers Assistant) | free | security context TBD |
| StudioDeviceSimulatorService | device matrix | yes (likely plugin) | Luau/plugin | native | high | new (May 2026) | free | UI lint |
| MicroProfiler LibMP / Scene Analysis | performance | yes | dumps + parser | native | medium | large outputs | free | budgets, not raw dumps |
| Rojo (sourcemap) | file mapping | yes | CLI | — | high | good | free | blox uses it as the mapping oracle |
| Lune / Jest-Roblox | offline Luau, tests | yes | CLI / Open Cloud | — | high | good | free | economy simulator, CI |
| Open Cloud Luau Execution | headless CI tests | yes | REST | published place | high | ≤5 min, ≤10 concurrent | free | CI lane |
| Open Cloud Place Publishing | release | yes | REST | — | high | good | free | human gate |
| Open Cloud Assets | upload mesh/model/audio/image | yes | REST | — | high | moderation latency | free (audio quotas) | provenance log |
| Thumbnail Personalization API | storefront A/B | yes | REST | — | high | 7-day settle | free | icons not writable |
| Configs/Experiments API | live tuning, A/B | yes | REST + ConfigService | — | high | MDE helper | free | put tunables in configs from day 1 |
| Analytics Query API | telemetry | yes | REST (async) | — | high | 5 h+ lag | free | post-launch loop |
| Cube / generate_mesh / procedural models | props | yes | Studio MCP | native | medium | quality varies | credits | already gated/cached in blox |
| Creator Store search/insert | reuse | yes | Studio MCP | native | high | script-backdoor risk | free | sanitize on insert |
| Blender (headless bpy; Blender Lab MCP) | mesh normalize, renders | yes | CLI / MCP | via FBX/GLB | high for scripted ops | good headless; MCP GUI-bound | free | prefer `-b --python` |
| Meshy / Tripo / Rodin / Hunyuan3D | text/image → 3D | yes | REST | export FBX/GLB | medium | style drift | paid | hero props only |
| Animation Capture; text→R15 tools | animation | partial | Studio / vendor | R15 | medium | vendor claims | free/paid | review required |
| ElevenLabs SFX | sound effects | yes | REST | upload | high | good | paid | commercial licence on paid plans |
| Roblox TTS / TextGeneration | runtime voice/NPC | yes | engine API | native | high | rate-limited | free | 300 chars/request |
| Image models (frontier image-edit APIs) | thumbnails, icons, UI art | yes | REST | upload decal | medium | consistent with references [I] | paid | must depict real gameplay |
| Figma (figma-console MCP present in this environment) | UI mockups | yes | MCP | export → code | low–medium | — | — | optional; code-first UI is simpler |
| Browser automation (Playwright) | Creator Hub tasks without APIs (icon upload) | yes | browser | — | medium | brittle | free | last resort; human-visible |
| Explore/games public APIs | market research | yes | REST (unauth) | — | high | sorts personalized | free | used in this report |
| GameAnalytics SDK (Roblox) | richer analytics | yes | Luau SDK + REST | yes | medium | 3P | freemium | optional beyond AnalyticsService |

---

## O. End-to-end pipeline by stage

The prompt's draft pipeline holds up, with three changes [I]:

- **Economy simulation and FTUE design come before the prototype.** They are cheap,
  and they decide retention.
- **Presentation is drafted alongside the prototype.** The verb, title and thumbnail
  shape the design ("the title is the tutorial").
- **Post-launch feeds Configs/Experiments,** not only code changes.

**AI access** is how directly an agent can reach the stage today; **Auto** is how much
of the stage it can do without a human.

| Stage | Required capabilities | Best tools | AI access | Auto | Current limits | Human role | blox implementation |
|---|---|---|---|---|---|---|---|
| Research | live sorts, game metadata, trend deltas over time | explore/games APIs, rolimons-style history | high | high | personalization; no conversion data | pick the bet | `blox research market` (prototype in `data/`) |
| Ideation | format match, differentiation, risk (IP, saturation) | format kits + market snapshot | high | medium | judging fun/novelty | choose concept/theme | rubric + 3 options |
| Design | loop, economy, progression, social, FTUE, monetization, tunables | `design.json` + economy sim | high | high | feel | approve monetization line | schema + sim |
| Prototype | greybox world, core verb, first reward | kit modules, world builders, tests | high | high | — | play it once | scaffold from kit |
| Production | full systems, data, purchases, analytics, configs | blessed modules, specs | high | high | multi-place, cross-server | — | existing core |
| World | layout, kit placement, terrain, lighting | builders, Cube, Creator Store, Blender | medium | medium | style consistency | art approval | layout generators + asset manifest |
| Assets / animation / audio | props, characters, anims, SFX | Cube, Meshy/Tripo + bpy, Animation Capture, ElevenLabs, Open Cloud | medium | medium–low | rigs, combat anims, licensing | approve spend and hero assets | `blox asset …` |
| UI | HUD, shop, reveal, mobile | UI kit, device simulator, lint | high | high | polish | taste pass | UI kit + `ui_lint` |
| Testing | specs, playtests, multiplayer, FTUE metrics, perf | blox runner, StudioTestService, VirtualInput, LibMP | high | high | real-player behaviour | — | new lanes (§J) |
| Presentation | icon, 5 thumbnails, title, description | render rig, image model, templates, policy lint | medium–high | medium | GFX polish, icon API absent | approve | `blox present` |
| Launch | publish, products, thumbnails, configs | Open Cloud | high | high | — | **approve publish** | `blox publish` (gated) |
| Post-launch | metrics → hypotheses → configs/experiments/content | Analytics Query, Experiments, Configs, Events | high | medium | 5 h lag; sample size | approve monetization changes; run events | `blox liveops` |

---

## P. Capability gaps in blox (as of main 3f600bd)

blox today: Studio session layer, push sync, in-engine spec runner (edit/server/client),
observed Play Solo playtests with probes, inputs and screenshots, task/criteria state,
an event log and dashboard, gated and cached asset generation, image → UI, the bench,
and the CLI/MCP/in-process adapters. Peripherals: dock, desktop app, auth, routing,
policy, relay.

| Capability | Current support | Desired support | Gap | Priority | Recommended approach |
|---|---|---|---|---|---|
| Market research | none | snapshot of explore sorts + games API, format/title/description stats | full | Medium | `blox research market` → JSON plus summary (the scripts in `data/` are the prototype) |
| Ideation / format choice | none | concept → format match → risks | full | High | format kits (below) + a rubric grounded in A/B of this doc |
| Game design spec | `task` goal + criteria | GDD schema: loop, economy topology, progression, social model, FTUE script, monetization surfaces, tunables | large | **High** | `design.json` in `.blox/`, validated; criteria derived from it |
| Proven system modules | scaffold only | tested modules: data (ProfileStore), remotes, purchases, analytics, configs, rebirth, index, eggs/rarity, base ownership, leaderboards, daily rewards, codes | large | **High** | "format kits" = modules + specs + world templates per format |
| Coding / backend | strong | + Server Authority defaults, DataStore mocks | small | Medium | guide + scaffold |
| Studio interaction | strong | + VirtualInput, device sim, perf capture | medium | High | dock-plugin RPC for plugin-security APIs |
| World creation | `world/*.luau` builders | layout templates, kit placement, terrain/lighting presets | medium | High | format-specific layout generators |
| Map evaluation | none | pathfinding reachability, spawn safety, traversal times, perf per region | full | Medium | `blox check map` as server-context specs |
| 3D assets | Cube/procedural via `studio_tool`, gated + cached | asset manifest with provenance/licence; Creator Store sanitizer; external gen → Blender normalize → upload | large | Medium | `assets.json` manifest; `blox asset import` pipeline |
| Animation | none | procedural helpers; R15 import from vendor/Capture; KeyframeSequence upload | large | Low–Medium | start with procedural + Creator Store animations |
| UI | code-built + image → UI | UI kit (HUD rail, currency bar, shop, toasts, reveal), mobile-first; deterministic UI lint | medium | **High** | UI module set + `ui_lint` playtest probe |
| Audio | none | library search + SFX generation + upload + SoundGroups | full | Medium | `blox asset audio` with licence record |
| Playtesting (single) | strong | + FTUE metrics, soak bots | medium | **High** | bot-behaviour library + metric probes |
| Multiplayer tests | none | 2–8 clients, invariants | full | **High** (theft/PvP formats need it) | StudioTestService via dock plugin |
| Performance | none | budgets: tris, parts, memory, frame time | full | Medium | Scene Analysis / LibMP summarised to numbers |
| Debugging | strong (typed logs, line mapping) | — | — | — | — |
| Visual QA | agent-judged screenshots | device-matrix screenshots + VLM rubric (advisory) + deterministic UI lint (gating) | medium | Medium | — |
| Economy balance | none | offline simulator over design.json | full | **High** | Lune/TS sim → curves + assertions |
| Thumbnails / icons | none | render rig (posed avatar + hero object + camera presets), compositor, 64 px readability check, 5 distinct variants | full | **High** | Studio-render first; image model optional |
| Title / description | none | template generator + policy lint (9+, no "Roblox", no misrepresentation) | full | Medium | — |
| Publishing | none | Open Cloud publish, human-approved | full | Medium | `blox publish` behind a confirm gate |
| Analytics / live-ops | none | Analytics Query + Configs/Experiments + Thumbnail API | full | Medium (post-launch) | `blox liveops report/propose` |
| Iteration on existing games | onboarding pull (`init`) | architecture map + regression specs before edits | medium | Medium | `explore` + generated characterization tests |
| Benchmarks | 7 code-level tasks | game-level tasks (format kit → playable with FTUE budget) + OpenGameEval cross-run | medium | Medium | — |

---

## Q. Recommended architecture

```
                 ┌───────────────────────────── Knowledge ─────────────────────────────┐
                 │ format kits (loop, economy, modules, layouts, FTUE script, UI kit,   │
                 │ presentation templates) · market snapshots · policy rules            │
                 └──────────────────────────────────────────────────────────────────────┘
 idea ─▶ DESIGN (design.json: loop, economy, progression, social, FTUE, monetization, tunables)
            │  validated by: schema + economy simulator (offline curves)
            ▼
        BUILD (existing blox core: files → sync → Studio)  ◀── blessed modules from the kit
            │  world builders · UI kit · assets via manifest (Cube | Store | ext→Blender→upload)
            ▼
        VERIFY
            ├─ unit/integration specs (edit/server/client)            [have]
            ├─ observed playtest + probes + screenshots                [have]
            ├─ FTUE metrics + soak bots                                [new]
            ├─ multiplayer lane (StudioTestService ≤8 via dock plugin) [new]
            ├─ UI lint × device matrix                                 [new]
            ├─ map checks (pathfinding, spawn safety) + perf budgets   [new]
            └─ visual rubric (VLM, advisory only)                      [new]
            ▼
        PRESENT (render rig → 5 thumbnail variants + icon; title/description templates; policy lint)
            ▼
        RELEASE (human gate) ── Open Cloud: place publish, assets, thumbnails, configs
            ▼
        LIVE-OPS loop: Analytics Query → findings → Config change / Experiment / content task
            │                                     (monetization changes: human gate)
            └──────────────────────────────▶ back to DESIGN/BUILD
```

Principles:

- **Keep the agent-agnostic contract.** Every new capability is a tool in
  `src/tools/registry.ts`, exposed over MCP and CLI. Claude-specific bits stay in the
  adapter.
- **Gate on deterministic checks.** Vision and LLM judgment only rank and suggest.
- **Data over prose.** `design.json`, `assets.json` and `presentation.json` are
  machine-checked. They make iteration and live-ops possible because the agent can
  diff intent against reality.
- **Human gates are explicit:**
  - spend: credits, paid generation APIs;
  - publish;
  - monetization changes;
  - licensed/IP themes;
  - final art approval.
- **Plugin-security APIs go through the dock plugin.** blox already ships a Studio
  plugin. The multiplayer lane, VirtualInput, device simulator and profiler become
  plugin RPCs; the MCP cannot reach them.

---

## R. Highest-value opportunities

Not ranked by score. Each entry gives impact, dependencies and difficulty.

1. **Format kits.** Proven-loop reference implementations: steal-and-defend tycoon,
   +1 incremental, round-based asymmetric, co-op survival, collection/RNG.
   - **What a kit holds:** tested modules, world layout generator, UI kit, FTUE
     script, design.json defaults, description/thumbnail templates.
   - **Impact:** the largest. The market rewards well-executed known loops (§A.2–A.3),
     and agents are far more reliable assembling and customizing tested systems than
     inventing them. It also turns "is this a good game?" partly into "does it match a
     known-good structure?".
   - **Dependencies:** the existing test infrastructure; the design schema.
   - **Difficulty:** medium per kit; start with one, the steal tycoon (current
     evidence) or +1 incremental (simplest).
2. **Design schema + economy simulator.**
   - **Impact:** high. It catches pacing and economy bugs before playtests, and it is
     what live-ops tunes later.
   - **Dependencies:** none.
   - **Difficulty:** low–medium, pure computation.
3. **Game-feel metrics in playtests:** FTUE timings, loop soak, error-free long runs.
   - **Impact:** high. It aligns the agent with what discovery now measures:
     retention [D].
   - **Dependencies:** the playtest probes we already have, plus a bot-behaviour
     library.
   - **Difficulty:** medium.
4. **Multiplayer test lane.**
   - **Impact:** high for every social or PvP format. Theft, trading and rounds cannot
     be verified solo.
   - **Dependencies:** the dock plugin RPC; StudioTestService.
   - **Difficulty:** medium–high (plugin security, the GetTestArgs bug, per-client
     control still limited).
5. **Presentation pipeline:** render rig, variants, readability check, title/description
   templates, Thumbnail Personalization API.
   - **Impact:** high on acquisition. It is the step most games, and every AI tool we
     found, skip.
   - **Dependencies:** a screenshot camera control we already have [V]; posed avatars;
     optional image model; Open Cloud key.
   - **Difficulty:** medium. Polish parity with pro GFX is hard. "Distinct, readable,
     truthful" is achievable.
6. **UI kit + deterministic UI lint across devices.**
   - **Impact:** medium–high. About 80% of sessions are on mobile, and UI bugs are the
     most visible quality signal.
   - **Dependencies:** device-simulator access via the plugin.
   - **Difficulty:** medium.
7. **Asset manifest + pipeline.** Provenance/licence, Creator Store sanitizer,
   Cube-first, external → Blender → upload second.
   - **Impact:** medium. Simulator art is blocky and code-buildable, so this matters
     more for horror, anime and creatures.
   - **Dependencies:** an Open Cloud key; Blender installed.
   - **Difficulty:** medium–high, because of style consistency.
8. **Publish + live-ops loop:** Analytics Query, Configs/Experiments.
   - **Impact:** high *after* launch; zero before.
   - **Dependencies:** a published universe, API keys, human gates.
   - **Difficulty:** medium.
9. **Map checks + performance budgets.**
   - **Impact:** medium.
   - **Difficulty:** low–medium; mostly Luau specs.

A suggested sequence: 2 → 1 (one kit) → 3 → 6 → 5 → 4 → 7 → 8, with 9 folded into the
kits. It front-loads what makes a single-player-verifiable game good, then adds social
and launch.

---

## S. Example agent workflows

### S.1 From concept: "Steal-and-defend tycoon with a snow theme"

1. **Research.** Run a `blox research market` snapshot. The steal tycoon is the
   current breakout (§A.2). Note the competition (Steal An Egg 1.28M CCU) and the
   saturated "egg" theme. Propose 3 theme variants. **Human picks.**
2. **Design.**
   1. Instantiate the steal-tycoon kit into `design.json`:
      - verb "Carve";
      - object snow-creature;
      - server size 6;
      - biomes ×5 gated by speed;
      - rarities ×7, mutations ×3;
      - offline income cap 8h;
      - rebirth ×1.5;
      - monetization: 2× cash pass, auto-collect pass, luck boost product. No paid
        theft protection beyond the shield timer.
   2. Run the economy sim. Assert:
      - first egg ≤60 s;
      - biome 2 at ~10 min;
      - first rebirth at ~45–60 min for an active player.
   3. Adjust the curves until the assertions pass.
3. **Build.**
   1. `scaffold` the kit. Its modules (base ownership, treadmill speed, carry/steal,
      hatch, index, rebirth, data, purchases, analytics funnels, configs) arrive with
      specs.
   2. The world builder generates the hub plus 5 radial biomes from the layout
      template.
   3. Props come from Creator Store search (sanitized) and Cube for the hero
      creatures. **The credit spend is approved once.**
   4. UI comes from the kit: currency bar, left rail, shop, hatch reveal.
4. **Verify.**
   - `run_tests`: module specs plus the game's specs.
   - `playtest` with the FTUE probe: core verb at 4 s ✓, first currency at 38 s ✓,
     two modals before control ✗ → fix.
   - Map checks: every biome reachable; spawn has no hazards in 20 studs.
   - Multiplayer lane, 3 clients:
     - client A steals from B;
     - B's shield blocks a second steal;
     - leave/rejoin keeps ownership;
     - no item duplication.
   - UI lint at phone portrait/landscape, tablet and 1080p.
   - A 10-minute soak: zero errors, flat memory.
5. **Present.**
   1. The render rig poses an avatar carrying the mythic creature, with a speed-trail
      background.
   2. Generate 5 variants: theft, hatch reveal, biome vista, rebirth, base.
   3. The icon is a single subject that is readable at 64 px.
   4. Title: "Carve a Snow Beast"; description from the template; policy lint passes.
   5. **The human approves the art.**
6. **Release.** **On human approval:** publish via Open Cloud and upload the
   thumbnails to personalization.
7. **Live-ops.** At day 3:
   1. The Analytics Query shows an onboarding funnel drop at "first steal" (−22%).
   2. The agent proposes an Experiment: guardian speed −15% for new players.
   3. Configs are already wired, so the change needs no code.
   4. A week later the agent reports the result and proposes content for the "UPDATES
      EVERY SATURDAY" cadence.

### S.2 From a reference (screenshot, video or description)

- **Screenshot.** A screenshot becomes a UI and scene inventory: blox's image path
  already does the UI part [V].
- **Gameplay video.** Sample frames, then have a VLM extract the verb, HUD elements,
  loop steps and monetization prompts. Map the result to the nearest format kit and
  produce `design.json` with "matched" vs "novel" systems flagged.
- **Design document.** Parse it into `design.json`. Unknowns go to `task block` for the
  human.

In every case the output is a *plan bound to tests*, not code first.
Inference [I]: reliable for the structure; weak for feel, such as combat timing.

### S.3 Iterating on an existing game

1. `init` pulls the place.
2. `explore` maps the services, remotes and data schema.
3. The agent generates **characterization specs** for current behaviour (what the
   currency does, what saves) *before* changing anything.
4. Add the feature with specs, playtest, and confirm the characterization specs still
   pass.
5. Optionally, read the live analytics to pick the weakness (funnel drop-off,
   underused shop tab).

---

## T. What still needs humans (answer to the final question)

The agent needs:

- a reliable Studio channel with sync and in-engine tests (blox has this);
- format knowledge as *tested code* rather than prose;
- a design data model with an economy simulator;
- playtests that measure feel proxies and run multiplayer;
- an asset pipeline with provenance and budgets;
- a presentation pipeline;
- Open Cloud for release and live-ops.

The environment should handle the plumbing so the agent never sees it:

- attach races and Studio ids;
- sync;
- plugin-security APIs;
- uploads and quotas;
- licence records;
- credit gates;
- the analytics plumbing.

Humans still decide:

- which concept and theme to bet on;
- whether it is fun;
- final art sign-off;
- money (generation spend, monetization design, pricing);
- publishing;
- live events and community.

The agent's job is to make those decisions cheap: evidence-backed options, playable
builds and measured results.

---

## Sources (accessed 2026-10-01)

Market and discovery:

- Live data: `apis.roblox.com/explore-api/v1/get-sorts`, `games.roblox.com/v1/games`,
  `thumbnails.roblox.com` (snapshot in `data/2026-10-01-explore/`)
- [Optimizing Discovery (Roblox, 2026-06-15)](https://about.roblox.com/newsroom/2026/06/optimizing-discovery-great-games-reach-millions-players-roblox)
- [Boost Your Discovery… (DevForum, 2026-08-06)](https://devforum.roblox.com/t/boost-your-discovery-by-building-games-people-want-to-play/4779042)
- [Q2 2026 shareholder letter](https://s27.q4cdn.com/984876518/files/doc_financials/2026/q2/Roblox-Q2-2026-Earnings-Shareholder-Letter.pdf) · [8-K](https://www.sec.gov/Archives/edgar/data/0001315098/000162828026051059/ex991-robloxq22026earnin.htm)
- [RDC 2026 (Roblox)](https://about.roblox.com/newsroom/2026/09/rdc-2026-the-world-needs-more-play) · [GamesBeat RDC briefing](https://gamesbeat.com/roblox-dives-into-the-details-on-its-rdc-engine-updates-roblox-wallet-and-offline-play-press-briefing/) · [PCGamesN RDC](https://www.pcgamesn.com/roblox/rdc-2026)
- [Steal a Brainrot (Wikipedia)](https://en.wikipedia.org/wiki/Steal_a_Brainrot) · [Grow a Garden (Wikipedia)](https://en.wikipedia.org/wiki/Grow_a_Garden) · [Steal An Egg (fandom)](https://roblox.fandom.com/wiki/And_Collect_Rare_Pets/Steal_An_Egg)
- [+1 Speed Keyboard Escape analysis (The Bloxline)](https://www.thebloxline.com/articles/1-speed-keyboard-escape-has-become-one-of-roblox-s-biggest-games-here-s-why-it-works)
- [99 Nights analysis (bloxodes)](https://bloxodes.com/articles/roblox-co-op-survival-games) · [RIA 2026 winners (Pocket Tactics)](https://www.pockettactics.com/roblox/innovation-awards-2026)
- [rblxdb live ranking](https://rblxdb.com/best-roblox-games) · [GameAnalytics 2026 Roblox Benchmark Report](https://www.gameanalytics.com/reports/2026-roblox-report)
- [Age checks for chat (Business Wire, 2026-01-07)](https://secure.businesswire.com/news/home/20260107986568/en/Roblox-Requires-Users-Worldwide-to-Age-Check-to-Access-Chat)

Presentation:

- [Thumbnails docs](https://create.roblox.com/docs/production/publishing/thumbnails) · [Thumbnail personalization live](https://devforum.roblox.com/t/live-now-personalize-your-thumbnails-to-attract-more-users/3257233) · [5 tips (2025-02-13)](https://devforum.roblox.com/t/5-tips-from-roblox-staff-to-get-the-most-out-of-thumbnail-personalization/3471689)
- [Metadata best practices PSA (2020)](https://devforum.roblox.com/t/psa-best-practices-for-game-metadata/764558) · [Experience guideline policy update](https://devforum.roblox.com/t/updating-experience-guideline-policies-to-keep-our-younger-users-safe/3249079)
- [Roblox thumbnail tooling (renderbux)](https://www.renderbux.com/guides/how-to-make-a-roblox-thumbnail) · [VizzBees vs RoThumbs](https://vizzbees.com/blog/vizzbees-vs-rothumbs)

Design, analytics, monetization:

- [Onboarding](https://create.roblox.com/docs/production/game-design/onboarding) · [Onboarding techniques](https://create.roblox.com/docs/production/game-design/onboarding-techniques) · [Core loops](https://create.roblox.com/docs/production/game-design/core-loops) · [Monetization foundations](https://create.roblox.com/docs/production/game-design/monetization-foundations)
- [Analytics event types](https://create.roblox.com/docs/production/analytics/event-types) · [Configs and experiments live](https://devforum.roblox.com/t/live-now-use-configs-and-experiments-to-grow-your-game-faster/4051385) · [Open Cloud Analytics/Events/Experiments/Thumbnail APIs (2026-08-24)](https://devforum.roblox.com/t/new-opencloud-apis-for-analytics-events-experiments-and-thumbnail-personalization/4828676)
- [Managed pricing](https://create.roblox.com/docs/production/monetization/managed-pricing) · [Rewarded ads / DevEx trends (rolearn)](https://rolearn.dev/trend-reports/roblox-monetization-trends-devex-creator-rewards/)
- [Greybox your environment](https://create.roblox.com/docs/tutorials/curriculums/environmental-art/greybox-your-environment) · [Designing UI tips (Roblox staff)](https://devforum.roblox.com/t/designing-ui-tips-and-best-practices/3074034)

Engineering, Studio, testing:

- [New Studio testing APIs (2026-05-28)](https://devforum.roblox.com/t/new-studio-testing-apis-and-assistant-improvements/4657854) · [StudioTestService](https://create.roblox.com/docs/reference/engine/classes/StudioTestService) · [VirtualInput](https://create.roblox.com/docs/reference/engine/classes/VirtualInput)
- [Playtest agent beta](https://devforum.roblox.com/t/studio-beta-studio-assistant-mcp-playtest-agent/4566767) · [Planning mode](https://devforum.roblox.com/t/announcing-planning-mode-for-roblox-assistant/4580715) · [MicroProfiler + Assistant (2026-06-26)](https://devforum.roblox.com/t/automated-performance-profiling-with-microprofiler-and-assistant/4704417)
- [Server Authority full release](https://devforum.roblox.com/t/full-release-ship-fair-and-competitive-games-with-server-authority/4727993) · [Text-to-Speech full release](https://devforum.roblox.com/t/build-more-immersive-experiences-text-to-speech-api-full-release/3986607) · [4D generation beta](https://devforum.roblox.com/t/beta-4d-generation-unlock-new-types-of-gameplay/4331818)
- [OpenGameEval](https://github.com/Roblox/open-game-eval) · [leaderboard](https://github.com/Roblox/open-game-eval/blob/main/LLM_LEADERBOARD.md) · [Jest-Roblox](https://github.com/Roblox/jest-roblox) · [TestEZ (archived)](https://github.com/Roblox/testez) · [Knit (archived)](https://github.com/Sleitnick/Knit)
- [Place publishing](https://create.roblox.com/docs/cloud/guides/usage-place-publishing) · [Assets API](https://create.roblox.com/docs/cloud/guides/usage-assets) · [More asset types (2025-10-23)](https://devforum.roblox.com/t/open-cloud-upload-support-for-more-asset-types/4022082) · [Audio assets](https://create.roblox.com/docs/audio/assets)
- [Rojo releases](https://github.com/rojo-rbx/rojo/releases) · [Argon](https://github.com/argon-rbx/argon/releases)

AI tools:

- [EL4CTEO/rbx-studio-mcp](https://github.com/EL4CTEO/rbx-studio-mcp) · [weppy-roblox-mcp](https://github.com/hope1026/weppy-roblox-mcp) · [BloxBot guide](https://www.bloxbot.ai/guide/whats-new-roblox-ai-2026) · [HyperDevs comparison (vendor)](https://hyperdevs.app/guides/best-ai-tools-for-roblox/) · [Ropilot comparison (vendor)](https://ropilot.ai/blog/lemonade-vs-superbullet-vs-ropilot)
- [Lemonade reviews](https://www.trustpilot.com/review/lemonade.gg) · [Lemonade (Miraheze wiki)](https://ai.miraheze.org/wiki/Lemonade_(Roblox_tool)) · ZeroScript/Superbullet: see `2026-09-30-landscape.md`
- [blender-mcp](https://github.com/ahujasid/blender-mcp) · [Official Blender Lab MCP](https://projects.blender.org/lab/blender_mcp/releases) · [Roblox Blender plugin](https://github.com/Roblox/roblox-blender-plugin/releases) · [RBXMonkey](https://extensions.blender.org/approval-queue/roblox-animations-importer-exporter/)
- [Meshy vs Tripo](https://www.meshy.ai/compare/meshy-vs-tripo) · [Roblox mesh limits (meshlox)](https://meshlox.com/learn/roblox-mesh-size-limits) · [Bloxlab text→R15](https://bloxlab.io/tools/roblox-animation-generator) · [NoCapMocap](https://www.nocapmocap.com/roblox) · [ElevenLabs API](https://elevenlabs.io/api)
- [Creator Store terms](https://en.help.roblox.com/hc/en-us/articles/21308223046932-Creator-Store-Terms) · [Creator Store docs](https://create.roblox.com/docs/production/creator-store)
