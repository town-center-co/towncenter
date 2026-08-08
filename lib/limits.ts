// Survey and map limits. Kept out of any "use server" module, which may only
// export async functions: a constant exported there arrives undefined in the
// importing client component, with no build error.

// past this the recherche-entreprises API silently truncates at 10 000 results.
export const MAX_ZONE_AREA_KM2 = 12;

// SaaS monthly quota: the cumulative surface an organisation may survey. Gated by
// MOLLIE_API_KEY — self-hosted instances never enforce it.
export const MAX_CUMULATIVE_AREA_KM2 = 50;

export const HARVEST_PAGES_PER_CALL = 25;

export const MAX_TARGETS_PER_HARVEST = 1_500;

export const ENRICH_BATCH_SIZE = 12;

export const UPSERT_CHUNK = 25; // bounds bound parameters per statement

export const MAX_TARGETS_IN_VIEW = 600;

export const MAX_TARGETS_FOR_STATS = 5_000;

export const CLUSTER_RADIUS_METERS = 300; // must equal the `near-live-deal` fact

export const MIN_CLUSTER_SIZE = 2;

export const MAX_PROXIMITY_ANCHORS = 2_000;

export const FRANCHISE_MIN_ESTABLISHMENTS = 5; // same threshold as `maxAddressesInGrid`

export const MIN_SECTOR_SIZE_FOR_SHARE = 12;

export const TILES_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

// fallback only: a commercial CDN whose unauthenticated use is tolerated, not granted.
export const TILES_STYLE_URL_FALLBACK =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// ASCII keys, declaration order is the stacking order. Every id starts with
// `sector` or `targets`: `stripBasemap()` recognises ours by those prefixes and
// would otherwise flatten their data-driven colours on every theme switch.
export const MAP_LAYERS = {
  sectorsFill: "sectors-fill",
  sectorsHatch: "sectors-hatch",
  sectorsOutline: "sectors-outline",
  sectorGhostFill: "sector-ghost-fill",
  sectorGhostLine: "sector-ghost-line",
  sectorDraftLine: "sector-draft-line",
  sectorDraftPoints: "sector-draft-points",
  targetsCluster: "targets-cluster",
  targetsClusterCount: "targets-cluster-count",
  targetsDots: "targets-dots",
  targetsPrice: "targets-price",
  targetsLabels: "targets-labels",
} as const;

export const CLUSTER_RADIUS_PX = 48;

export const CLUSTER_ZOOM_MAX = 15;

export const PRICE_ZOOM_MIN = 14;

export const PULSE_GHOST_MS = 2_500;

export const PULSE_GHOST_OPACITY = { min: 0.1, max: 0.28 } as const;

// licence obligation (ODbL): never pass `attributionControl: false`, the style JSON
// carries no `attribution` field. Screenshots and video must re-embed this by hand.
export const TILES_ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
