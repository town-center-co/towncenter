// Surveying a sector: opening the `zones` row, bounded pagination, writing,
// closing.
// Every page is written as soon as it is read: a failure on page 22 leaves the
// first twenty-one stored and the sector resumes at 22. `harvestArea()` in
// `lib/sources/sirene.ts` accumulates in memory instead, for benches only.

import "server-only";

import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { MESSAGE_EXPIRED, MESSAGE_START_TRIAL } from "@/lib/billing/quotas";
import { getBillingState } from "@/lib/billing/subscriptions";
import { db, events, targets, zones, type NewTarget, type Zone } from "@/lib/db";
import { areaKm2, normalizeBbox, pointInPolygon } from "@/lib/geo";
import {
  HARVEST_PAGES_PER_CALL,
  MAX_CUMULATIVE_AREA_KM2,
  MAX_TARGETS_PER_HARVEST,
  MAX_ZONE_AREA_KM2,
  UPSERT_CHUNK,
} from "@/lib/limits";
import {
  circleForBbox,
  createTally,
  nafLabel,
  normalizeEstablishments,
  searchNearPoint,
  SireneError,
  SIRENE_DEFAULT_NAF_CODES,
  SIRENE_MAX_PER_PAGE,
  SIRENE_MAX_REQUESTS_PER_HARVEST,
  SIRENE_MAX_RESULT_WINDOW,
  SIRENE_MIN_INTERVAL_MS,
  type HarvestTally,
} from "@/lib/sources/sirene";
import type { Bbox, LatLng, SireneEstablishment } from "@/lib/types";

// re-exported so the UI can quote the cap without importing the API client.
export const HARVEST_MAX_REQUESTS = SIRENE_MAX_REQUESTS_PER_HARVEST;

// calls are spaced module-wide by `lib/sources/sirene.ts`; the quota is per IP
// address, so concurrent surveys share one queue.
export const HARVEST_REQUESTS_PER_SECOND = Math.round(1_000 / SIRENE_MIN_INTERVAL_MS);

export function toNewTarget(
  ownerId: string,
  establishment: SireneEstablishment,
): NewTarget {
  return {
    ownerId,
    siren: establishment.siren,
    siret: establishment.siret,
    name: establishment.name,
    legalName: establishment.legalName,
    naf: establishment.naf,
    nafLabel: establishment.nafLabel ?? nafLabel(establishment.naf),
    address: establishment.address,
    postalCode: establishment.postalCode,
    city: establishment.city,
    lat: establishment.lat,
    lng: establishment.lng,
    establishmentCount: establishment.establishmentCount,
    companyCreatedAt: establishment.companyCreatedAt,
    employeeRange: establishment.employeeRange,
    companyCategory: establishment.companyCategory,
    revenueCents: establishment.revenueCents,
    netIncomeCents: establishment.netIncomeCents,
    financesYear: establishment.financesYear,
    directors: establishment.directors,
  };
}

export type UpsertTally = {
  /** Rows written, re-harvest duplicates included. */
  found: number;
  /** Those not already in the database. */
  created: number;
  createdSirets: string[];
};

// `UPSERT_CHUNK` slicing bounds the number of bound parameters per statement.
export async function upsertTargets(
  ownerId: string,
  batch: readonly SireneEstablishment[],
): Promise<UpsertTally> {
  // a NaN coordinate would insert as null and fail the whole batch on a NOT
  // NULL column.
  const rows = batch.filter(
    (item) =>
      item.siret !== "" && Number.isFinite(item.lat) && Number.isFinite(item.lng),
  );

  if (rows.length === 0) return { found: 0, created: 0, createdSirets: [] };

  const known = new Set<string>();
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    const slice = rows.slice(index, index + UPSERT_CHUNK);
    const existing = await db
      .select({ siret: targets.siret })
      .from(targets)
      .where(
        and(
          eq(targets.ownerId, ownerId),
          inArray(
            targets.siret,
            slice.map((item) => item.siret),
          ),
        ),
      );
    for (const row of existing) known.add(row.siret);
  }

  const createdSirets = rows
    .filter((item) => !known.has(item.siret))
    .map((item) => item.siret);

  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    await db
      .insert(targets)
      .values(
        rows
          .slice(index, index + UPSERT_CHUNK)
          .map((item) => toNewTarget(ownerId, item)),
      )
      .onConflictDoUpdate({
        // must match the real UNIQUE index `targets_owner_siret_key`, which
        // carries two columns; `siret` alone fails on the second survey only.
        target: [targets.ownerId, targets.siret],
        // only SIRENE columns: a re-harvest must not erase the Google
        // enrichment, the site audit, `state`, `capturedAt` or `notes`.
        set: {
          siren: sql`excluded.siren`,
          name: sql`excluded.name`,
          legalName: sql`excluded.legal_name`,
          naf: sql`excluded.naf`,
          nafLabel: sql`excluded.naf_label`,
          address: sql`excluded.address`,
          postalCode: sql`excluded.postal_code`,
          city: sql`excluded.city`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          establishmentCount: sql`excluded.establishment_count`,
          companyCreatedAt: sql`excluded.company_created_at`,
          employeeRange: sql`excluded.employee_range`,
          companyCategory: sql`excluded.company_category`,
          revenueCents: sql`excluded.revenue_cents`,
          netIncomeCents: sql`excluded.net_income_cents`,
          financesYear: sql`excluded.finances_year`,
          directors: sql`excluded.directors`,
          updatedAt: sql`now()`,
        },
      });
  }

  return { found: rows.length, created: createdSirets.length, createdSirets };
}

// one `survey` event per newly discovered SIRET; a re-harvest logs nothing
// again.
async function logSpotting(
  ownerId: string,
  sirets: readonly string[],
): Promise<number> {
  if (sirets.length === 0) return 0;

  let logged = 0;

  for (let index = 0; index < sirets.length; index += UPSERT_CHUNK) {
    const slice = sirets.slice(index, index + UPSERT_CHUNK);
    const rows = await db
      .select({ id: targets.id })
      .from(targets)
      .where(
        and(eq(targets.ownerId, ownerId), inArray(targets.siret, [...slice])),
      );

    if (rows.length === 0) continue;

    await db.insert(events).values(
      rows.map((row) => ({
        ownerId,
        targetId: row.id,
        kind: "survey" as const,
      })),
    );

    logged += rows.length;
  }

  return logged;
}

export type ZoneRefusal = {
  reason: "surface" | "naf" | "billing";
  message: string;
};

export type OpenZoneRequest = {
  ownerId: string;
  bbox: Bbox;
  nafCodes?: readonly string[];
  label?: string | null;
};

// a refusal is returned, never thrown, and lands before the first network call.
export async function openZone(
  request: OpenZoneRequest,
): Promise<{ zoneId: string; bbox: Bbox; nafCodes: string[] } | ZoneRefusal> {
  const bbox = normalizeBbox(request.bbox);
  const area = areaKm2(bbox);

  if (!Number.isFinite(area) || area <= 0) {
    return {
      reason: "surface",
      message: "Unreadable sector. Draw it again on the map.",
    };
  }

  if (area > MAX_ZONE_AREA_KM2) {
    return {
      reason: "surface",
      message: `Sector too large: ${area.toFixed(1)} km² for ${MAX_ZONE_AREA_KM2} km² at most. Draw a neighbourhood rather than a town.`,
    };
  }

  if (process.env.MOLLIE_API_KEY) {
    const billing = await getBillingState(request.ownerId);

    // no mandate yet, or a lapsed one: nothing costly opens, data stays readable.
    if (billing.state === "none") {
      return { reason: "billing", message: MESSAGE_START_TRIAL };
    }
    if (billing.state === "expired") {
      return { reason: "billing", message: MESSAGE_EXPIRED };
    }

    const periodStart = billing.periodStart;

    const existing = await db
      .select({ bbox: zones.bbox })
      .from(zones)
      .where(
        periodStart
          ? and(
              eq(zones.ownerId, request.ownerId),
              gte(zones.startedAt, periodStart),
            )
          : eq(zones.ownerId, request.ownerId),
      );

    const cumulative = existing.reduce(
      (sum, row) => sum + areaKm2(row.bbox as Bbox),
      0,
    );

    if (cumulative + area > MAX_CUMULATIVE_AREA_KM2) {
      const total = cumulative + area;
      return {
        reason: "surface",
        message: `Cumulative limit reached: ${cumulative.toFixed(1)} km² already surveyed this period. Adding ${area.toFixed(1)} km² would reach ${total.toFixed(1)} km² (limit: ${MAX_CUMULATIVE_AREA_KM2} km²). Manage your plan on the Billing screen.`,
      };
    }
  }

  const nafCodes =
    request.nafCodes && request.nafCodes.length > 0
      ? [...request.nafCodes]
      : [...SIRENE_DEFAULT_NAF_CODES];

  const [created] = await db
    .insert(zones)
    .values({
      ownerId: request.ownerId,
      label: request.label ?? null,
      bbox,
      nafCodes,
    })
    .returning({ id: zones.id });

  if (!created) {
    return { reason: "surface", message: "Sector cannot be opened." };
  }

  return { zoneId: created.id, bbox, nafCodes };
}

// a `failed` sector is resumable, a `done` one is not.
export async function resumeZone(
  ownerId: string,
  zoneId: string,
): Promise<Zone | null> {
  const [zone] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.ownerId, ownerId), eq(zones.id, zoneId)))
    .limit(1);
  if (!zone) return null;
  if (zone.status === "done") return null;

  if (zone.status === "failed") {
    await db
      .update(zones)
      .set({ status: "running", error: null, finishedAt: null })
      .where(eq(zones.id, zoneId));
  }

  return zone;
}

export type HarvestSliceRequest = {
  /** Isolation boundary: it reaches every row written. */
  ownerId: string;
  zoneId: string;
  bbox: Bbox;
  /** The API only knows circles: the box is queried wide and filtered here. */
  polygon?: readonly LatLng[] | null;
  nafCodes: readonly string[];
  /** 1 on the first call, `nextPage` afterwards. */
  startPage: number;
  maxPages?: number;
  /** Targets already written for this sector, so the cap bites. */
  alreadyFound?: number;
};

/** Serializable: never an `Error`. */
export type HarvestFailure = {
  message: string;
  retryable: boolean;
  /** Everything before it is stored. */
  page: number;
};

export type HarvestSlice = {
  zoneId: string;
  firstPage: number;
  /** Last page actually read AND written. */
  lastPage: number;
  /** `null` when the sector is finished. */
  nextPage: number | null;
  requests: number;
  /** `total_results` announced by the API. A FLOOR, not a total. */
  totalResults: number;
  /** Re-harvest duplicates included. */
  found: number;
  created: number;
  /** Sector totals, this slice included. */
  zoneFound: number;
  zoneNew: number;
  tally: HarvestTally;
  outsidePolygon: number;
  spotted: number;
  done: boolean;
  truncated: boolean;
  /** The 10 000-result window is saturated: the sector is too large. */
  saturated: boolean;
  /** Everything before it has been written; `found` and `lastPage` still hold. */
  failure: HarvestFailure | null;
};

// never throws on a network failure: it comes back in `failure`, after
// everything already read has been written.
export async function harvestSlice(
  request: HarvestSliceRequest,
): Promise<HarvestSlice> {
  const bbox = normalizeBbox(request.bbox);
  const circle = circleForBbox(bbox);
  const nafCodes =
    request.nafCodes.length > 0 ? request.nafCodes : SIRENE_DEFAULT_NAF_CODES;
  const contour =
    request.polygon && request.polygon.length >= 3 ? request.polygon : null;

  const maxPages = Math.min(
    HARVEST_PAGES_PER_CALL,
    Math.max(1, request.maxPages ?? HARVEST_PAGES_PER_CALL),
  );

  const tally = createTally();
  const seenSirets = new Set<string>();

  const firstPage = Math.max(1, Math.floor(request.startPage) || 1);
  let page = firstPage;
  let lastPage = firstPage - 1;
  let requests = 0;
  let totalResults = 0;
  let found = 0;
  let created = 0;
  let outsidePolygon = 0;
  let spotted = 0;
  let truncated = false;
  let done = false;
  let failure: HarvestFailure | null = null;

  let zoneTotal = Math.max(0, request.alreadyFound ?? 0);

  for (let step = 0; step < maxPages; step += 1) {
    // `page * per_page` cannot exceed 10 000: past that the API answers 400.
    if (
      page * SIRENE_MAX_PER_PAGE > SIRENE_MAX_RESULT_WINDOW ||
      page > HARVEST_MAX_REQUESTS
    ) {
      truncated = true;
      done = true;
      break;
    }

    if (zoneTotal >= MAX_TARGETS_PER_HARVEST) {
      truncated = true;
      done = true;
      break;
    }

    let batch: SireneEstablishment[];

    try {
      const response = await searchNearPoint({
        lat: circle.lat,
        lng: circle.lng,
        radiusKm: circle.radiusKm,
        nafCodes,
        page,
        perPage: SIRENE_MAX_PER_PAGE,
      });
      requests += 1;
      if (step === 0) totalResults = response.total_results;

      // stop on an EMPTY page, never on `total_pages`: the API keeps serving
      // distinct results past the last announced page.
      if (response.results.length === 0) {
        done = true;
        break;
      }

      batch = normalizeEstablishments(response, bbox, {
        nafCodes,
        tally,
        seenSirets,
      });
    } catch (error) {
      // leave the loop, cancel nothing: `nextPage` points back at this page.
      failure = {
        message:
          error instanceof SireneError
            ? error.message
            : "The company register did not answer.",
        retryable: error instanceof SireneError ? error.retryable : true,
        page,
      };
      console.error(`[survey] sector ${request.zoneId} page ${page}`, error);
      break;
    }

    if (contour) {
      const before = batch.length;
      batch = batch.filter((item) => pointInPolygon(item, contour));
      outsidePolygon += before - batch.length;
    }

    if (zoneTotal + batch.length > MAX_TARGETS_PER_HARVEST) {
      batch = batch.slice(0, Math.max(0, MAX_TARGETS_PER_HARVEST - zoneTotal));
      truncated = true;
    }

    try {
      const written = await upsertTargets(request.ownerId, batch);
      found += written.found;
      created += written.created;
      zoneTotal += written.found;
      // log before moving on, so a later failure cannot leave written targets
      // without their spotting events.
      spotted += await logSpotting(request.ownerId, written.createdSirets);
    } catch (error) {
      // a failed write is not retryable: insisting would only burn quota.
      failure = {
        message: "Could not save.",
        retryable: false,
        page,
      };
      console.error(`[survey] write ${request.zoneId} page ${page}`, error);
      break;
    }

    lastPage = page;
    page += 1;
  }

  // written even after a failure.
  let zoneFound = zoneTotal;
  let zoneNew = created;

  if (found > 0 || created > 0) {
    const [row] = await db
      .update(zones)
      .set({
        targetsFound: sql`${zones.targetsFound} + ${found}`,
        targetsNew: sql`${zones.targetsNew} + ${created}`,
      })
      .where(eq(zones.id, request.zoneId))
      .returning({
        targetsFound: zones.targetsFound,
        targetsNew: zones.targetsNew,
      });
    zoneFound = row?.targetsFound ?? zoneTotal;
    zoneNew = row?.targetsNew ?? created;
  } else {
    const [row] = await db
      .select({ targetsFound: zones.targetsFound, targetsNew: zones.targetsNew })
      .from(zones)
      .where(eq(zones.id, request.zoneId))
      .limit(1);
    zoneFound = row?.targetsFound ?? zoneTotal;
    zoneNew = row?.targetsNew ?? created;
  }

  if (zoneFound >= MAX_TARGETS_PER_HARVEST) {
    truncated = true;
    done = true;
  }

  if (failure) {
    await closeZone(request.zoneId, { status: "failed", error: failure.message });
  } else if (done) {
    await closeZone(request.zoneId, { status: "done" });
  }

  // a filter that never rejects anything is broken; the tally is the only way
  // to see it.
  console.info(
    `[survey] sector ${request.zoneId} pages ${firstPage}-${lastPage}:`,
    JSON.stringify({ ...tally, outsidePolygon, spotted }),
  );

  return {
    zoneId: request.zoneId,
    firstPage,
    lastPage,
    nextPage: done ? null : failure ? failure.page : page,
    requests,
    totalResults,
    found,
    created,
    zoneFound,
    zoneNew,
    tally,
    outsidePolygon,
    spotted,
    done,
    truncated,
    saturated: totalResults >= SIRENE_MAX_RESULT_WINDOW,
    failure,
  };
}

export async function closeZone(
  zoneId: string,
  outcome: { status: "done" | "failed"; error?: string | null },
): Promise<void> {
  await db
    .update(zones)
    .set({
      status: outcome.status,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(zones.id, zoneId));
}
