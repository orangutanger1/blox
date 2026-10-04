export type Web = Record<string, unknown | ((url: string) => unknown)>;
export function fakeFetch(web: Web, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const key = Object.keys(web).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const v = typeof web[key] === 'function' ? (web[key] as (u: string) => unknown)(url) : web[key];
    return { ok: true, status: 200, json: async () => v };
  };
}

const chartGame = (universeId: number, name: string, playerCount: number, extra: Record<string, unknown> = {}) => ({
  universeId, rootPlaceId: universeId + 1, name, playerCount, totalUpVotes: 900, totalDownVotes: 100, isSponsored: false, genreL1: 'Simulation', ...extra,
});
export const SORTS = {
  sorts: [
    { sortId: 'filters_v5', sortDisplayName: '' },
    { sortId: 'top-trending', games: [chartGame(1, '[⚡] Ride A Pet', 5000), chartGame(2, 'Steal An Egg', 9000), chartGame(9, 'Ad Game', 1, { isSponsored: true })] },
    { sortId: 'up-and-coming', games: [chartGame(2, 'Steal An Egg', 9100), chartGame(3, 'Tower Thing', 300, { genreL1: '' })] },
  ],
};
const detail = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `G${id}`, description: `desc ${id}`, creator: { name: 'Maker', type: 'Group' }, playing: 1, visits: id * 1000, maxPlayers: 8,
  created: '2026-08-01T00:00:00Z', updated: '2026-10-01T00:00:00Z', genre_l1: 'Simulation', genre_l2: 'Tycoon', ...extra,
});
export const WEB: Web = {
  'https://apis.roblox.com/explore-api/v1/get-sorts': SORTS,
  'https://games.roblox.com/v1/games?universeIds=': (u: string) => ({
    data: new URL(u).searchParams.get('universeIds')!.split(',').map(Number).map((id) => detail(id, id === 3 ? { genre_l1: 'Strategy', genre_l2: 'Tower Defense' } : {})),
  }),
  'https://apis.roblox.com/game-passes/v1/universes/': {
    gamePasses: [
      { id: 1, name: 'VIP', isForSale: true, price: 399 },
      { id: 2, name: 'Old', isForSale: false, price: null },
    ],
  },
};
