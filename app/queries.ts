// Read layer. Every exported read takes its owner as FIRST parameter: the
// compiler enforces the parameter, only the where clause enforces isolation.
// A role grants nothing across accounts.

// Loot, resistance and expected value are never stored: they are recomputed
// on every read.

// Money is integer cents, ratings integer tenths. Everything returned is
// serialisable: ISO strings, never Date objects, which a client cannot read back.

// ensureGoogleRetention() is the one write here: it purges Google facts past 30
// days, is throttled, and cannot fail the read that triggered it. Google's terms
// allow keeping place_id durably and nothing else, so expired fields must come
// back null rather than merely flagged. Driving it from reads is what meets the
// deadline on an instance nobody enriches.

import "server-only";

import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";

import type { Account } from "@/lib/accounts";
import { getCumulativeAreaKm2 as readCumulativeAreaKm2 } from "@/lib/billing/area";
import { mollieEnabled, mollieTestMode } from "@/lib/billing/mollie";
import { getQuotaUsage } from "@/lib/billing/quotas";
import {
  getBillingState,
  type BillingStateKind,
} from "@/lib/billing/subscriptions";
import {
  db,
  events,
  LEDGER_ORDER_DESC,
  priceGrids,
  targets,
  users,
  zones,
  type Target,
} from "@/lib/db";
import { areaKm2, distanceMeters, normalizeBbox, streetKey } from "@/lib/geo";
import {
  CLUSTER_RADIUS_METERS,
  FRANCHISE_MIN_ESTABLISHMENTS,
  MAX_CUMULATIVE_AREA_KM2,
  MAX_PROXIMITY_ANCHORS,
  MAX_TARGETS_FOR_STATS,
  MAX_TARGETS_IN_VIEW,
  MIN_CLUSTER_SIZE,
} from "@/lib/limits";
import { ensureGoogleRetention } from "@/lib/retention";
import { DEFAULT_PRICE_GRID, readPriceGrid } from "@/lib/priceGrid";
import { lootReason, scorePlace } from "@/lib/scoring";
import {
  getAccountPlacesKey,
  maskKey,
  type PlacesKeySource,
} from "@/lib/settings";
import { envPlacesKey, isGoogleDataStale } from "@/lib/sources/places";
import {
  CALIBRATION_MIN_OUTCOMES,
  type Bbox,
  type EventKind,
  type LatLng,
  type PlaceScore,
  type PriceGrid,
  type ProximityFact,
  type ScoringFacts,
  type SiteAuditFacts,
  type SubscriptionStatus,
  type TargetState,
  type ZoneStatus,
} from "@/lib/types";

// A business on the map. Google fields are hidden (null) past 30 days rather
// than merely flagged: the terms forbid keeping them, so also showing them.
export type TargetRow = {
  id: string;
  siren: string;
  siret: string;
  name: string;
  legalName: string | null;
  naf: string | null;
  nafLabel: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  lat: number;
  lng: number;
  establishmentCount: number | null;
  /** YYYY-MM-DD. */
  companyCreatedAt: string | null;
  employeeRange: string | null;
  companyCategory: string | null;
  revenueCents: number | null;
  netIncomeCents: number | null;
  financesYear: number | null;
  directors: { lastName: string; firstNames: string | null; title: string }[];
  googlePlaceId: string | null;
  googleFetchedAt: string | null;
  googleStale: boolean;
  ratingTenths: number | null;
  reviewCount: number | null;
  priceLevel: number | null;
  phone: string | null;
  websiteUrl: string | null;
  businessStatus: string | null;
  openingHours: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
    periods?: unknown[];
  } | null;
  /**
   * Hand-typed. Wins over Google on read, and never expires: the 30-day rule
   * covers what Google supplies, not what you noted yourself.
   */
  manualWebsiteUrl: string | null;
  manualPhone: string | null;
  manualNotedAt: string | null;
  siteAudit: SiteAuditFacts | null;
  /** Null while the audit never ran, which is NOT "no site". */
  auditedAt: string | null;
  enriched: boolean;
  state: TargetState;
  capturedAt: string | null;
  notes: string | null;
  harvestedAt: string;
  proximity: ProximityFact;
  score: PlaceScore;
  lootReason: string;
  resistancePercent: number;
};

export type TargetSortKey =
  | "expectancy"
  | "loot"
  | "odds"
  | "resistance"
  | "name"
  | "surveyed";
export type SortDir = "asc" | "desc";

export type TargetFilters = {
  /** Empty or absent: everything EXCEPT the ones set aside. */
  states?: readonly TargetState[];
  nafCodes?: readonly string[];
  q?: string;
  sort?: TargetSortKey;
  dir?: SortDir;
  limit?: number;
};

export type TargetsInBbox = {
  rows: TargetRow[];
  total: number;
  truncated: boolean;
  outcomeCount: number;
  calibrated: boolean;
};

export type TargetNeighbour = {
  id: string;
  name: string;
  address: string | null;
  /** Rounded metres, real great-circle distance, not the SQL sort metric. */
  distanceMeters: number;
  state: TargetState;
  expectancyCents: number;
};

export type TargetDetail = {
  target: TargetRow;
  log: JournalEntry[];
  neighbours: TargetNeighbour[];
};

export type ZoneStats = {
  lootCents: number;
  bestExpectancyCents: number;
  /** CENTS actually signed here, read from the ledger, never estimated. */
  capturedCents: number;
  total: number;
  countByState: Record<TargetState, number>;
  hold: number;
  /**
   * Off-grid businesses: their expected value is zero by construction, which is
   * not the same as being worth zero, so they never enter the loot.
   */
  offGridCount: number;
  notEnrichedCount: number;
  staleGoogleCount: number;
  /** True when the read ceiling cut in: the loot is a FLOOR. */
  truncated: boolean;
  calibrated: boolean;
  outcomeCount: number;
};

export type TargetCluster = {
  id: string;
  center: LatLng;
  targetIds: string[];
  count: number;
  lootCents: number;
  topTargetId: string;
  topName: string;
  radiusMeters: number;
};

export type JournalEntry = {
  id: string;
  targetId: string;
  targetName: string;
  kind: EventKind;
  valueCents: number | null;
  note: string | null;
  occurredAt: string;
};

export type FrontLine = {
  target: TargetRow;
  action: string;
  reason: string;
  daysSinceLastEvent: number | null;
  overdue: boolean;
};

export type ZoneRow = {
  id: string;
  label: string | null;
  bbox: Bbox;
  nafCodes: string[];
  status: ZoneStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  targetsFound: number;
  targetsNew: number;
  areaKm2: number;
  // current state of the ground, recounted on read rather than read off `zones`
  surveyed: number;
  approached: number;
  captures: number;
  withdrawals: number;
  setAside: number;
  hold: number;
  capturedLootCents: number;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// The owner clause lives in the same function as the frame on purpose: a caller
// that forgot it would not show an empty page, it would show someone else's
// businesses. normalizeBbox first, or a sector drawn right to left gives
// minLat > maxLat and a silently empty frame.
export function bboxCondition(ownerId: string, bbox: Bbox): SQL {
  const box = normalizeBbox(bbox);
  return and(
    eq(targets.ownerId, ownerId),
    gte(targets.lat, box.minLat),
    lte(targets.lat, box.maxLat),
    gte(targets.lng, box.minLng),
    lte(targets.lng, box.maxLng),
  ) as SQL;
}

type ProximityAnchor = {
  lat: number;
  lng: number;
  street: string | null;
  signature: boolean;
  live: boolean;
};

// Only what left `spotted` is loaded: counting untouched businesses would make
// "near a live deal" true everywhere, and therefore meaningless.
async function loadProximityAnchors(ownerId: string): Promise<ProximityAnchor[]> {
  const rows = await db
    .select({
      lat: targets.lat,
      lng: targets.lng,
      address: targets.address,
      state: targets.state,
    })
    .from(targets)
    .where(and(eq(targets.ownerId, ownerId), ne(targets.state, "spotted")))
    .limit(MAX_PROXIMITY_ANCHORS);

  return rows.map((row) => ({
    lat: row.lat,
    lng: row.lng,
    street: streetKey(row.address),
    signature: row.state === "taken",
    live: row.state === "studied" || row.state === "engaged" || row.state === "taken",
  }));
}

// `outside-zone` cannot come out of here: a business read in a frame is in it.
function proximityFor(
  point: { lat: number; lng: number; address: string | null },
  anchors: readonly ProximityAnchor[],
): ProximityFact {
  const street = streetKey(point.address);
  let live = false;

  for (const anchor of anchors) {
    if (anchor.signature && street !== null && anchor.street === street) {
      return "same-street-capture";
    }
    if (anchor.live && distanceMeters(point, anchor) <= CLUSTER_RADIUS_METERS) {
      live = true;
    }
  }

  return live ? "near-live-deal" : "in-zone";
}

// `site: null` is a never-run audit, a NEUTRAL factor; "no site found" is
// issue: "no_known_site". Confusing the two floats every unseen business to the top.
function factsFor(
  record: Target,
  proximity: ProximityFact,
  googleStale: boolean,
): ScoringFacts {
  const site: SiteAuditFacts | null = record.siteAudit ?? null;
  const establishments = record.establishmentCount;

  return {
    openEstablishmentCount: establishments,
    companyCreatedAt: record.companyCreatedAt,
    revenueCents: record.revenueCents,
    financesYear: record.financesYear,
    employeeRange: record.employeeRange,
    companyCategory: record.companyCategory,
    ratingTenths: googleStale ? null : record.ratingTenths,
    reviewCount: googleStale ? null : record.reviewCount,
    priceLevel: googleStale ? null : record.priceLevel,
    // a hand-typed number is not Google data, so it never goes stale
    hasPhone: Boolean(record.manualPhone) || (!googleStale && Boolean(record.phone)),
    // the audit does not look for contact forms yet: a plain false beats an
    // invented signal
    hasContactForm: false,
    directorCount: record.directors.length,
    site,
    proximity,
    isOpen: record.businessStatus !== "CLOSED_PERMANENTLY",
    // always true: the harvest drops records whose owner exercised their right
    // to object before writing them
    isDiffusible: true,
    isFranchiseGroupSite:
      establishments !== null &&
      establishments > FRANCHISE_MIN_ESTABLISHMENTS &&
      site?.issue === "site_ok",
  };
}

function toTargetRow(
  record: Target,
  anchors: readonly ProximityAnchor[],
  outcomeCount: number,
  now: string,
  grid: PriceGrid,
): TargetRow {
  const hasGoogle = record.googleFetchedAt !== null;
  const googleStale = hasGoogle && isGoogleDataStale(record.googleFetchedAt);

  const proximity = proximityFor(
    { lat: record.lat, lng: record.lng, address: record.address },
    anchors,
  );

  const score = scorePlace(factsFor(record, proximity, googleStale), {
    outcomeCount,
    now,
    grid,
  });

  return {
    id: record.id,
    siren: record.siren,
    siret: record.siret,
    name: record.name,
    legalName: record.legalName,
    naf: record.naf,
    nafLabel: record.nafLabel,
    address: record.address,
    postalCode: record.postalCode,
    city: record.city,
    lat: record.lat,
    lng: record.lng,
    establishmentCount: record.establishmentCount,
    companyCreatedAt: record.companyCreatedAt,
    employeeRange: record.employeeRange,
    companyCategory: record.companyCategory,
    revenueCents: record.revenueCents,
    netIncomeCents: record.netIncomeCents,
    financesYear: record.financesYear,
    directors: record.directors,
    googlePlaceId: record.googlePlaceId,
    googleFetchedAt: toIso(record.googleFetchedAt),
    googleStale,
    // hidden, not merely flagged: past 30 days Google's terms forbid keeping
    // these fields, so also showing them
    ratingTenths: googleStale ? null : record.ratingTenths,
    reviewCount: googleStale ? null : record.reviewCount,
    priceLevel: googleStale ? null : record.priceLevel,
    phone: googleStale ? null : record.phone,
    websiteUrl: googleStale ? null : record.websiteUrl,
    businessStatus: googleStale ? null : record.businessStatus,
    openingHours: googleStale ? null : record.openingHours,
    manualWebsiteUrl: record.manualWebsiteUrl,
    manualPhone: record.manualPhone,
    manualNotedAt: toIso(record.manualNotedAt),
    siteAudit: record.siteAudit,
    auditedAt: toIso(record.auditedAt),
    enriched: hasGoogle || record.auditedAt !== null,
    state: record.state,
    capturedAt: toIso(record.capturedAt),
    notes: record.notes,
    harvestedAt: record.harvestedAt.toISOString(),
    proximity,
    score,
    lootReason: lootReason(score, record.establishmentCount),
    resistancePercent: 100 - score.success.percent,
  };
}

// Takes and withdrawals, nothing else. Below CALIBRATION_MIN_OUTCOMES the
// displayed resistance is an opinion, not a measure, and the interface says so.
export async function getOutcomeCount(owner: Account): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(targets)
    .where(
      and(
        eq(targets.ownerId, owner.id),
        inArray(targets.state, ["taken", "withdrawn"]),
      ),
    );

  return Number(row?.total ?? 0);
}

// A missing row is the NORMAL case: a new account plays on DEFAULT_PRICE_GRID
// until it saves one. readPriceGrid() falls back rather than blanking amounts.
export async function getPriceGrid(owner: Account): Promise<PriceGrid> {
  const [row] = await db
    .select({ grid: priceGrids.grid })
    .from(priceGrids)
    .where(eq(priceGrids.ownerId, owner.id))
    .limit(1);

  return row ? readPriceGrid(row.grid) : DEFAULT_PRICE_GRID;
}

export async function hasCustomPriceGrid(owner: Account): Promise<boolean> {
  const [row] = await db
    .select({ ownerId: priceGrids.ownerId })
    .from(priceGrids)
    .where(eq(priceGrids.ownerId, owner.id))
    .limit(1);

  return Boolean(row);
}

export async function countZones(owner: Account): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(zones)
    .where(eq(zones.ownerId, owner.id));

  return Number(row?.total ?? 0);
}

// what the setup screen shows: facts only, each backed by a row or the environment
export type OnboardingFacts = {
  onboardedAt: string | null;
  placesKeySource: PlacesKeySource;
  placesKeyMask: string | null;
  hasCustomGrid: boolean;
  sectorCount: number;
  isSaaS: boolean;
};

export async function getOnboardingFacts(
  owner: Account,
): Promise<OnboardingFacts> {
  const [userRow] = await db
    .select({ onboardedAt: users.onboardedAt })
    .from(users)
    .where(eq(users.id, owner.id))
    .limit(1);

  const [key, hasCustomGrid, sectorCount] = await Promise.all([
    getAccountPlacesKey(owner.id),
    hasCustomPriceGrid(owner),
    countZones(owner),
  ]);

  return {
    onboardedAt: userRow?.onboardedAt?.toISOString() ?? null,
    placesKeySource: key ? "account" : envPlacesKey() ? "env" : null,
    placesKeyMask: key ? maskKey(key) : null,
    hasCustomGrid,
    sectorCount,
    isSaaS: process.env.NEXT_PUBLIC_SAAS === "true",
  };
}

export type Banked = {
  cents: number;
  captures: number;
};

export async function getBankedTotalCents(owner: Account): Promise<Banked> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${events.valueCents}), 0)`,
      // count(column) counts only non-null rows, so the count and the sum
      // describe the same takes; count(*) could announce three takes behind the
      // sum of two amounts
      count: sql<number>`count(${events.valueCents})`,
    })
    .from(events)
    .where(and(eq(events.ownerId, owner.id), eq(events.kind, "take")));

  return { cents: Number(row?.total ?? 0), captures: Number(row?.count ?? 0) };
}

function filterConditions(filters: TargetFilters): SQL[] {
  const parts: SQL[] = [];

  const states = filters.states ?? [];
  if (states.length > 0) {
    parts.push(inArray(targets.state, [...states]) as SQL);
  } else {
    parts.push(ne(targets.state, "dismissed") as SQL);
  }

  const naf = (filters.nafCodes ?? []).filter((code) => code.trim() !== "");
  if (naf.length > 0) {
    parts.push(inArray(targets.naf, naf) as SQL);
  }

  const q = (filters.q ?? "").trim().toLowerCase();
  if (q !== "") {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    parts.push(
      sql`(lower(${targets.name}) like ${like}
        or lower(coalesce(${targets.legalName}, '')) like ${like}
        or lower(coalesce(${targets.address}, '')) like ${like})`,
    );
  }

  return parts;
}

// `odds` sorts on the RAW probability, never the clamped one: the display floor
// collapses 2.5 % and 0.26 %, and the bottom of the file would order BY PRICE.
function sortRows(rows: TargetRow[], filters: TargetFilters): TargetRow[] {
  const sort = filters.sort ?? "expectancy";
  const sign = filters.dir === "asc" ? 1 : -1;

  if (sort === "name") {
    return [...rows].sort((a, b) => a.name.localeCompare(b.name, "fr") * sign);
  }
  if (sort === "surveyed") {
    return [...rows].sort(
      (a, b) => (Date.parse(a.harvestedAt) - Date.parse(b.harvestedAt)) * sign,
    );
  }

  // `resistance` is the RAW probability negated, never `resistancePercent`: that
  // one is rounded to a step of 5, so a third of the file would tie and fall back
  // to the alphabet. Same reason `odds` reads the raw value.
  const value = (row: TargetRow): number => {
    switch (sort) {
      case "loot":
        return row.score.price.value12MonthsCents;
      case "odds":
        return row.score.success.rawProbability;
      case "resistance":
        return -row.score.success.rawProbability;
      default:
        return row.score.expectancyCents;
    }
  };

  return [...rows].sort((a, b) => {
    const delta = (value(a) - value(b)) * sign;
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name, "fr");
  });
}

// SORT BEFORE CUTTING: rows come back in index order, north to south, so cutting
// at MAX_TARGETS_IN_VIEW before scoring would keep the northernmost rows and
// still call the result "sorted by expected value".
export async function listTargetsInBbox(
  owner: Account,
  bbox: Bbox,
  filters: TargetFilters = {},
): Promise<TargetsInBbox> {
  await ensureGoogleRetention();

  const limit = Math.min(
    MAX_TARGETS_IN_VIEW,
    Math.max(1, filters.limit ?? MAX_TARGETS_IN_VIEW),
  );
  const where = and(bboxCondition(owner.id, bbox), ...filterConditions(filters)) as SQL;

  const [records, tallyRows, anchors, outcomeCount, grid] =
    await Promise.all([
    db
      .select()
      .from(targets)
      .where(where)
      // the READ ceiling, not the display one
      .orderBy(desc(targets.harvestedAt))
      .limit(MAX_TARGETS_FOR_STATS),
    db.select({ total: sql<number>`count(*)` }).from(targets).where(where),
    loadProximityAnchors(owner.id),
    getOutcomeCount(owner),
    getPriceGrid(owner),
  ]);

  const now = new Date().toISOString();
  const rows = records.map((record) =>
    toTargetRow(record, anchors, outcomeCount, now, grid),
  );
  const ranked = sortRows(rows, filters);
  const kept = ranked.slice(0, limit);
  const total = Number(tallyRows[0]?.total ?? rows.length);

  return {
    rows: kept,
    total,
    truncated: total > kept.length,
    outcomeCount,
    calibrated: outcomeCount >= CALIBRATION_MIN_OUTCOMES,
  };
}

// A DISPLAY ceiling and nothing else: no count, share or percentage may be
// computed over these eight rows.
const NEIGHBOURS_LIMIT = 8;

export async function getTargetRow(owner: Account, id: string): Promise<TargetRow | null> {
  const [record] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, id)))
    .limit(1);
  if (!record) return null;

  const [anchors, outcomeCount, grid] =
    await Promise.all([
    loadProximityAnchors(owner.id),
    getOutcomeCount(owner),
    getPriceGrid(owner),
  ]);

  return toTargetRow(record, anchors, outcomeCount, new Date().toISOString(), grid);
}

// Neighbours are sorted by distance IN SQL, before the ceiling: taking eight
// rows and sorting them after would return an arbitrary sample. The DISPLAYED
// distance is a real haversine computed over the rows kept.
export async function getTargetDetail(owner: Account, id: string): Promise<TargetDetail | null> {
  await ensureGoogleRetention();

  const [record] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, id)))
    .limit(1);
  if (!record) return null;

  const [anchors, outcomeCount, grid] =
    await Promise.all([
    loadProximityAnchors(owner.id),
    getOutcomeCount(owner),
    getPriceGrid(owner),
  ]);

  const now = new Date().toISOString();
  const target = toTargetRow(record, anchors, outcomeCount, now, grid);

  const latSpan = CLUSTER_RADIUS_METERS / (111_195 * 1);
  const cosLat = Math.cos((record.lat * Math.PI) / 180);
  // floored at 0.2: near the poles the factor explodes and the frame wraps the Earth
  const safeCos = Math.max(0.2, Math.abs(cosLat));
  const lngSpan = latSpan / safeCos;
  const cos2 = safeCos * safeCos;

  const near = and(
    eq(targets.ownerId, owner.id),
    gte(targets.lat, record.lat - latSpan),
    lte(targets.lat, record.lat + latSpan),
    gte(targets.lng, record.lng - lngSpan),
    lte(targets.lng, record.lng + lngSpan),
    ne(targets.id, record.id),
  ) as SQL;

  // Squared planar distance, longitude corrected, monotone with the real one at
  // this scale. Only NUMBERS may go in the fragment: the driver rejects a Date.
  const byDistance = sql`(
    (${targets.lat} - ${record.lat}) * (${targets.lat} - ${record.lat})
    + (${targets.lng} - ${record.lng}) * (${targets.lng} - ${record.lng}) * ${cos2}
  )`;

  const [neighbourRecords, log] =
    await Promise.all([
    db
      .select()
      .from(targets)
      .where(near)
      .orderBy(byDistance)
      .limit(MAX_TARGETS_FOR_STATS),
    listJournal(owner, { targetId: record.id, limit: 40 }),
  ]);

  const neighbourRows = neighbourRecords.map((row) => ({
    record: row,
    row: toTargetRow(row, anchors, outcomeCount, now, grid),
  }));

  const neighbours: TargetNeighbour[] = neighbourRows
    .slice(0, NEIGHBOURS_LIMIT)
    .map(({ record: raw, row: neighbour }) => ({
      id: neighbour.id,
      name: neighbour.name,
      address: neighbour.address,
      distanceMeters: Math.round(distanceMeters(record, raw)),
      state: neighbour.state,
      expectancyCents: neighbour.score.expectancyCents,
    }));

  return {
    target,
    log,
    neighbours,
  };
}

function emptyStateCounts(): Record<TargetState, number> {
  return {
    spotted: 0,
    studied: 0,
    engaged: 0,
    taken: 0,
    withdrawn: 0,
    dismissed: 0,
  };
}

export async function getZoneStats(owner: Account, bbox: Bbox): Promise<ZoneStats> {
  const where = bboxCondition(owner.id, bbox);

  const [records, anchors, outcomeCount, takenRows, grid] =
    await Promise.all([
    db
      .select()
      .from(targets)
      .where(where)
      .orderBy(desc(targets.harvestedAt))
      .limit(MAX_TARGETS_FOR_STATS + 1),
    loadProximityAnchors(owner.id),
    getOutcomeCount(owner),
    db
      .select({ total: sql<number>`coalesce(sum(${events.valueCents}), 0)` })
      .from(events)
      .innerJoin(targets, eq(targets.id, events.targetId))
      .where(and(eq(events.ownerId, owner.id), eq(events.kind, "take"), where)),
    getPriceGrid(owner),
  ]);

  const truncated = records.length > MAX_TARGETS_FOR_STATS;
  const now = new Date().toISOString();
  const countByState = emptyStateCounts();

  let lootCents = 0;
  let bestExpectancyCents = 0;
  let offGridCount = 0;
  let notEnrichedCount = 0;
  let staleGoogleCount = 0;
  let total = 0;

  for (const record of records.slice(0, MAX_TARGETS_FOR_STATS)) {
    const row = toTargetRow(record, anchors, outcomeCount, now, grid);
    total += 1;
    countByState[row.state] += 1;

    if (row.googleStale) staleGoogleCount += 1;
    if (!row.enriched) notEnrichedCount += 1;
    if (row.score.price.kind === "off-grid") offGridCount += 1;

    // neither taken, lost nor set aside: what is really left to go and get
    if (row.state === "taken" || row.state === "withdrawn" || row.state === "dismissed") {
      continue;
    }

    lootCents += row.score.expectancyCents;
    if (row.score.expectancyCents > bestExpectancyCents) {
      bestExpectancyCents = row.score.expectancyCents;
    }
  }

  return {
    lootCents,
    bestExpectancyCents,
    capturedCents: Number(takenRows[0]?.total ?? 0),
    total,
    countByState,
    hold: total > 0 ? countByState.taken / total : 0,
    offGridCount,
    notEnrichedCount,
    staleGoogleCount,
    truncated,
    calibrated: outcomeCount >= CALIBRATION_MIN_OUTCOMES,
    outcomeCount,
  };
}

// Grouped in TypeScript over rows already loaded, never in SQL: the grouping
// depends on the expected value, which exists in no column.
export function getClusters(
  rows: readonly TargetRow[],
  radiusMeters: number = CLUSTER_RADIUS_METERS,
): TargetCluster[] {
  const radius = Math.max(1, radiusMeters);

  const candidates = rows
    .filter(
      (row) =>
        row.state !== "taken" && row.state !== "withdrawn" && row.state !== "dismissed",
    )
    .sort((a, b) => b.score.expectancyCents - a.score.expectancyCents);

  const taken = new Set<string>();
  const clusters: TargetCluster[] = [];

  for (const head of candidates) {
    if (taken.has(head.id)) continue;

    const members: TargetRow[] = [head];
    taken.add(head.id);

    for (const other of candidates) {
      if (taken.has(other.id)) continue;
      if (distanceMeters(head, other) > radius) continue;
      members.push(other);
      taken.add(other.id);
    }

    if (members.length < MIN_CLUSTER_SIZE) continue;

    const center: LatLng = {
      lat: members.reduce((sum, row) => sum + row.lat, 0) / members.length,
      lng: members.reduce((sum, row) => sum + row.lng, 0) / members.length,
    };

    clusters.push({
      // stable across renders while the head does not change, so the map does
      // not redraw its bubbles
      id: `cluster-${head.siret}`,
      center,
      targetIds: members.map((row) => row.id),
      count: members.length,
      lootCents: members.reduce((sum, row) => sum + row.score.expectancyCents, 0),
      topTargetId: head.id,
      topName: head.name,
      radiusMeters: Math.round(
        members.reduce((max, row) => Math.max(max, distanceMeters(center, row)), 0),
      ),
    });
  }

  return clusters.sort((a, b) => b.lootCents - a.lootCents);
}

export type JournalFilters = {
  targetId?: string;
  kinds?: readonly EventKind[];
  /** ISO. Only returns facts from this instant onwards. */
  since?: string;
  limit?: number;
};

export async function listJournal(
  owner: Account,
  filters: JournalFilters = {},
): Promise<JournalEntry[]> {
  const parts: SQL[] = [eq(events.ownerId, owner.id) as SQL];
  if (filters.targetId) parts.push(eq(events.targetId, filters.targetId) as SQL);
  if (filters.kinds && filters.kinds.length > 0) {
    parts.push(inArray(events.kind, [...filters.kinds]) as SQL);
  }
  if (filters.since) {
    const at = new Date(filters.since);
    if (!Number.isNaN(at.getTime())) parts.push(gte(events.occurredAt, at) as SQL);
  }

  const rows = await db
    .select({
      id: events.id,
      targetId: events.targetId,
      targetName: targets.name,
      kind: events.kind,
      valueCents: events.valueCents,
      note: events.note,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(targets, eq(targets.id, events.targetId))
    .where(and(...parts) as SQL)
    // Two facts fit in the same occurred_at, and Postgres has no rowid, hence
    // `seq`. The tie-break comes from the schema (LEDGER_ORDER_DESC) rather than
    // an expression copied here: rollback ERASES what this read SHOWS.
    .orderBy(...LEDGER_ORDER_DESC)
    .limit(Math.min(500, Math.max(1, filters.limit ?? 50)));

  return rows.map((row) => ({
    id: row.id,
    targetId: row.targetId,
    targetName: row.targetName,
    kind: row.kind,
    valueCents: row.valueCents,
    note: row.note,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

const FOLLOWUP_AFTER_DAYS = 3;

export async function listFront(owner: Account, limit = 5): Promise<FrontLine[]> {
  const [records, anchors, outcomeCount, lastEvents, grid] =
    await Promise.all([
    db
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.ownerId, owner.id),
          inArray(targets.state, ["spotted", "studied", "engaged"]),
        ),
      )
      .limit(MAX_TARGETS_FOR_STATS),
    loadProximityAnchors(owner.id),
    getOutcomeCount(owner),
    db
      .select({
        targetId: events.targetId,
        lastAt: sql<number>`max(${events.occurredAt})`,
      })
      .from(events)
      .where(eq(events.ownerId, owner.id))
      .groupBy(events.targetId),
    getPriceGrid(owner),
  ]);

  // max() over a timestamp column comes back as raw SECONDS: drizzle only
  // remaps columns projected as-is, not aggregates
  const lastByTarget = new Map<string, number>();
  for (const row of lastEvents) {
    const seconds = Number(row.lastAt);
    if (Number.isFinite(seconds)) lastByTarget.set(row.targetId, seconds * 1_000);
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();

  const lines = records.map((record) => {
    const target = toTargetRow(record, anchors, outcomeCount, now, grid);
    const lastAt = lastByTarget.get(record.id) ?? null;
    const daysSinceLastEvent =
      lastAt === null
        ? null
        : Math.floor((nowDate.getTime() - lastAt) / 86_400_000);

    return { target, daysSinceLastEvent };
  });

  const scored = lines.map((line) => {
    const { target, daysSinceLastEvent } = line;

    if (target.state === "engaged") {
      const late = daysSinceLastEvent ?? 0;
      const overdue = late >= FOLLOWUP_AFTER_DAYS;
      return {
        ...line,
        action: "Follow up",
        reason:
          daysSinceLastEvent === null
            ? "engaged, no trace of contact"
            : `follow-up due for ${late} d`,
        priority: overdue ? 0 : 1,
        overdue,
      };
    }

    if (target.state === "studied") {
      return {
        ...line,
        action: "Call",
        reason: `resistance ${target.resistancePercent} % · ${target.lootReason}`,
        priority: 2,
        overdue: false,
      };
    }

    return {
      ...line,
      action: "Walk past",
      reason: target.lootReason,
      priority: 3,
      overdue: false,
    };
  });

  const places = Math.max(1, limit);

  const ranked = [...scored].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.target.score.expectancyCents - a.target.score.expectancyCents;
  });

  const kept = ranked.slice(0, places);

  // expectancyCents is ZERO on an off-grid target by construction, so the sort
  // always puts them last while they are often the dearest deals in the file.
  // One seat, never more, ranked among themselves by establishment count.
  const isOffGrid = (row: (typeof ranked)[number]): boolean =>
    row.target.score.price.kind === "off-grid";

  if (places >= 2 && !kept.some(isOffGrid)) {
    const bestOffGrid = [...ranked].filter(isOffGrid).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const establishments =
        (b.target.establishmentCount ?? 0) - (a.target.establishmentCount ?? 0);
      if (establishments !== 0) return establishments;
      return a.target.name.localeCompare(b.target.name, "fr");
    })[0];

    if (bestOffGrid) {
      kept[kept.length - 1] = {
        ...bestOffGrid,
        // the verb follows the seat: an off-grid target is not called, it is
        // PRICED: a visit and a hand-written quote
        action: "Price it",
        reason: `${bestOffGrid.reason} · seat reserved for off-grid`,
      };
    }
  }

  return kept.map(({ target, action, reason, daysSinceLastEvent, overdue }) => ({
    target,
    action,
    reason,
    daysSinceLastEvent,
    overdue,
  }));
}

// Failed harvests STAY in the list: a harvest that failed is exactly what you
// need to know in order to run it again.
export async function listZones(owner: Account, limit = 20): Promise<ZoneRow[]> {
  const rows = await db
    .select()
    .from(zones)
    .where(eq(zones.ownerId, owner.id))
    .orderBy(desc(zones.startedAt))
    .limit(Math.min(100, Math.max(1, limit)));

  const out: ZoneRow[] = [];

  for (const zone of rows) {
    const where = bboxCondition(owner.id, zone.bbox);

    const [byState, takenRows] =
    await Promise.all([
      db
        .select({ state: targets.state, total: sql<number>`count(*)` })
        .from(targets)
        .where(where)
        .groupBy(targets.state),
      db
        .select({ total: sql<number>`coalesce(sum(${events.valueCents}), 0)` })
        .from(events)
        .innerJoin(targets, eq(targets.id, events.targetId))
        .where(and(eq(events.ownerId, owner.id), eq(events.kind, "take"), where)),
    ]);

    const counts = emptyStateCounts();
    for (const row of byState) counts[row.state] = Number(row.total);

    const surveyed = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // "approached" = left `spotted`, whatever came next. A lost business WAS
    // approached: dropping it would make a sector with ten refusals look
    // untouched.
    const approached =
      counts.studied + counts.engaged + counts.taken + counts.withdrawn;

    out.push({
      id: zone.id,
      label: zone.label,
      bbox: zone.bbox,
      nafCodes: zone.nafCodes,
      status: zone.status,
      error: zone.error,
      startedAt: zone.startedAt.toISOString(),
      finishedAt: toIso(zone.finishedAt),
      targetsFound: zone.targetsFound,
      targetsNew: zone.targetsNew,
      areaKm2: areaKm2(zone.bbox),
      surveyed,
      approached,
      captures: counts.taken,
      withdrawals: counts.withdrawn,
      setAside: counts.dismissed,
      hold: surveyed > 0 ? counts.taken / surveyed : 0,
      capturedLootCents: Number(takenRows[0]?.total ?? 0),
    });
  }

  return out;
}

/**
 * Sums the zones opened in the current quota window. Gated behind
 * MOLLIE_API_KEY: self-hosted never enforces the cumulative ceiling, so the
 * value is only fetched when billing is active. A current subscription counts
 * from its paid period; an unpaid account counts everything it ever opened.
 */
export async function getCumulativeAreaKm2(owner: Account): Promise<{
  km2: number;
  maxKm2: number;
}> {
  const billing = await getBillingState(owner.id);
  const periodStart = billing.periodStart;

  const km2 = await readCumulativeAreaKm2(owner.id, periodStart);

  return { km2, maxKm2: MAX_CUMULATIVE_AREA_KM2 };
}

export type BillingFacts = {
  enabled: boolean;
  testMode: boolean;
  /** The lifecycle stage; drives everything the billing page shows. */
  state: BillingStateKind;
  /** "none" when the account never went near billing. */
  status: SubscriptionStatus | "none";
  /** Paid through now — `canceled` stays current until the period runs out. */
  current: boolean;
  /** Non-null once a mandate opened a trial; the account gets exactly one. */
  trialEndsAtIso: string | null;
  periodEndIso: string | null;
  usedKm2: number;
  maxKm2: number;
  /** The three counted quotas beside the surface one. */
  usage: {
    harvest: { used: number; limit: number };
    enrich: { used: number; limit: number };
    audit: { used: number; limit: number };
  };
};

export async function getBillingFacts(owner: Account): Promise<BillingFacts> {
  if (!mollieEnabled()) {
    return {
      enabled: false,
      testMode: false,
      state: "self-hosted",
      status: "none",
      current: false,
      trialEndsAtIso: null,
      periodEndIso: null,
      usedKm2: 0,
      maxKm2: MAX_CUMULATIVE_AREA_KM2,
      usage: {
        harvest: { used: 0, limit: 0 },
        enrich: { used: 0, limit: 0 },
        audit: { used: 0, limit: 0 },
      },
    };
  }

  const [billing, quotas] = await Promise.all([
    getBillingState(owner.id),
    getQuotaUsage(owner.id),
  ]);
  const row = billing.row;

  return {
    enabled: true,
    testMode: mollieTestMode(),
    state: billing.state,
    status: row?.status ?? "none",
    current: billing.state === "trial" || billing.state === "active",
    trialEndsAtIso: row?.trialEndsAt?.toISOString() ?? null,
    periodEndIso: row?.currentPeriodEnd?.toISOString() ?? null,
    usedKm2: quotas.area.used,
    maxKm2: quotas.area.limit,
    usage: {
      harvest: { used: quotas.harvest.used, limit: quotas.harvest.limit },
      enrich: { used: quotas.enrich.used, limit: quotas.enrich.limit },
      audit: { used: quotas.audit.used, limit: quotas.audit.limit },
    },
  };
}

// Pages calling these reads must set `export const dynamic = "force-dynamic"`,
// or Next prerenders them at build time and freezes the database state into the
// HTML. To order by progress import TARGET_STATE_RANK from @/lib/types.
