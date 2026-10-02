# Explore-sort snapshot, 2026-10-01

Public Roblox endpoints, no auth:

1. `apis.roblox.com/explore-api/v1/get-sorts?device=all&country=all` → five sorts
   (Top Trending 89, Up-and-Coming 41, Top Playing Now 97, Fun with Friends 90,
   Top Revisited 81), 281 unique universes. Save the response as `sorts.json`.
2. `node fetch.js` → `games.v1/games?universeIds=` details (description, created,
   updated, visits, maxPlayers, genre_l1/l2) → `games.json`.
3. `node analyze.js` → title/description feature table per sort.

`explore-2026-10-01.tsv` is the compact result (descriptions omitted). `sorts` = which
sort and rank each game appeared at. One snapshot, one moment, one (unpersonalized)
session: sort membership is personalized and changes hourly, so treat counts as a
sample, not a census.
