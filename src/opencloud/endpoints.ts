// Open Cloud paths in one place. Place publishing and Assets are long-standing,
// documented APIs. Analytics Query, Configs and Thumbnail Personalization are
// newer (2025–2026): their paths/bodies below follow the docs as read on
// 2026-10-01 and MUST be checked against current docs before the first real call.
export const ENDPOINTS = {
  placePublish: (universeId: number, placeId: number) => `/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`,
  analyticsMetrics: (universeId: number) => `/analytics-query-api/v1/universes/${universeId}/metrics`,
  configs: (universeId: number) => `/cloud/v2/universes/${universeId}/configs`,
  thumbnails: (universeId: number) => `/cloud/v2/universes/${universeId}/thumbnails`,
};
export const UNVERIFIED_ENDPOINTS = ['analyticsMetrics', 'configs', 'thumbnails'] as const;
