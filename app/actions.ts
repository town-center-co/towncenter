"use server";

// Every write in the product. A "use server" module may export ONLY async
// functions, and must never `export type` an imported type: that emits a
// runtime re-export of an identifier erased at compile time, so tsc and the
// build both pass and the page dies on the first click. Types therefore live in
// @/app/actionState and arrive here as `import type`.
//
// Every action is a public POST endpoint: it calls requireUser() on its first
// line and validates its input with zod before touching anything. What crosses
// the server -> client boundary is flat and serialisable, and money is always
// integer cents.

import { refresh } from "next/cache";

import { requireUser } from "@/lib/accounts";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { plural, STATE_LABEL } from "@/components/map/text";
import {
  db,
  events,
  LEDGER_ORDER_DESC,
  targets,
  zones,
  type NewTarget,
  type Target,
} from "@/lib/db";
import { checkQuota } from "@/lib/billing/quotas";
import { formatEuros } from "@/lib/format";
import { normalizeBbox } from "@/lib/geo";
import { ENRICH_BATCH_SIZE } from "@/lib/limits";
import { harvestSlice, openZone, resumeZone } from "@/lib/harvest";
import { purgeStaleGoogleFacts } from "@/lib/retention";
import { auditSite } from "@/lib/sources/audit";
import { getPlacesKey } from "@/lib/settings";
import {
  findPlaceFor,
  isGoogleDataStale,
  PlacesError,
} from "@/lib/sources/places";
import {
  GOOGLE_FRESHNESS_DAYS,
  TARGET_STATE_RANK,
  type Bbox,
  type EventKind,
  type LatLng,
  type PlaceScore,
  type TargetState,
} from "@/lib/types";

import { bboxCondition, getTargetRow } from "./queries";

import type {
  ActionResult,
  ActionState,
  AdvanceResult,
  DeleteZoneResult,
  DismissResult,
  EnrichResult,
  SurveyResult,
  UndoResult,
  SectorResult,
} from "./actionState";

// Duration cap for one enrichment call; ENRICH_BATCH_SIZE caps the count. Both
// are needed: a slow site can blow a proxy timeout long before the batch fills.
// Checked before each business, never mid-way.
const ENRICH_TIME_BUDGET_MS = 20_000;

// how many recent sectors are re-read to find the one containing a point
const ZONES_FOR_HOLD = 200;

// Refreshes the client tree after a write. refresh() throws outside a Server
// Action, and this call sits after the writes: letting it surface would report
// a failure on work already saved. Pages are force-dynamic, so no cache to
// invalidate — only the client tree to send back up.
function refreshTree(): void {
  try {
    refresh();
  } catch (error) {
    // message only, no stack: test benches call these actions outside Next
    console.error(
      "[refresh] client tree not refreshed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function fail(
  previous: ActionState,
  message: string,
  fieldErrors: Record<string, string> = {},
  values: Record<string, string> = {},
): ActionState {
  return {
    status: "error",
    message,
    fieldErrors,
    values,
    result: null,
    token: previous.token + 1,
  };
}

// A failure that still produced something. The harvest writes each page as it
// reads it, so the caller needs the result alongside the alert to know where to
// resume.
function partial(
  previous: ActionState,
  message: string,
  result: ActionResult,
): ActionState {
  return {
    status: "error",
    message,
    fieldErrors: {},
    values: {},
    result,
    token: previous.token + 1,
  };
}

// `result` may be null: not every action produces a machine-readable outcome.
function done(
  previous: ActionState,
  message: string,
  result: ActionResult | null,
): ActionState {
  return {
    status: "success",
    message,
    fieldErrors: {},
    values: {},
    result,
    token: previous.token + 1,
  };
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Reads a JSON form field. Never throws: `undefined` if absent, `null` if unreadable. */
function json(form: FormData, name: string): unknown {
  const raw = field(form, name);
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// zod messages keyed by the control's `name` attribute; a nested path
// (frame.minLat) collapses to its root, otherwise the error renders next to
// nothing.
function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// A row id is a crypto.randomUUID(). Checked here and not only by the `where`:
// an action is a public POST endpoint, and an arbitrary string has no business
// reaching a query, parameterised or not.
const idSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: "Unreadable identifier.",
  });

const bboxSchema = z.object({
  minLat: z.number().min(-90).max(90),
  maxLat: z.number().min(-90).max(90),
  minLng: z.number().min(-180).max(180),
  maxLng: z.number().min(-180).max(180),
});

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Hand-drawn outline. Three vertices minimum, and the 2 000 ceiling is not
// cosmetic: every vertex is tested against every business in the frame.
const polygonSchema = z.array(latLngSchema).min(3).max(2_000);

/** NAF 2008 codes, e.g. `56.10A`. The API rejects NAF 2025 codes. */
const nafSchema = z
  .array(z.string().regex(/^\d{2}\.\d{2}[A-Z]$/, { message: "Unreadable NAF code." }))
  .max(40);

const surveySchema = z.object({
  frame: bboxSchema.optional(),
  contour: polygonSchema.nullish(),
  naf: nafSchema.nullish(),
  label: z.string().max(120).nullish(),
  zoneId: idSchema.nullish(),
  page: z.number().int().min(1).max(10_000).nullish(),
});

const frameSchema = z.object({ frame: bboxSchema });
const targetSchema = z.object({ id: idSchema });

// `field` is an ASCII key, never a label: it picks the column. An empty value
// is not an error, it is an erasure, and Google's value takes over again.
const inputSchema = z.object({
  id: idSchema,
  field: z.enum(["website", "phone"]),
  value: z.string().max(500, { message: "500 characters at most." }),
});

// The label is visible text, not a key. The 120-character ceiling matches the
// one the harvest applies: both write the same column, so both must refuse the
// same thing. An empty label erases the name and is stored as null, never "".
const renameSchema = z.object({
  id: idSchema,
  label: z.string().max(120, { message: "120 characters at most." }),
});

// The only destinations of an advance. `spotted` is the starting state and is
// never returned to; `dismissed` belongs to dismissTargetAction, not here.
const advanceSchema = z.object({
  id: idSchema,
  to: z.enum(["studied", "engaged", "taken", "withdrawn"]),
  amountCents: z.number().int().min(0).max(1_000_000_000).nullish(),
  note: z.string().max(2_000).nullish(),
});

/**
 * Hand-typed euros to integer cents. Accepts what a keyboard and a copy-paste
 * actually produce: `3500`, `3 500`, `3 500,00`, `3500.50`, `3 500 €`. Returns
 * null on anything else and NEVER NaN, which would land as null in a money
 * column and lose the signed amount silently.
 */
function parseEurosToCents(raw: string): number | null {
  const clean = raw
    // JavaScript's \s already covers the non-breaking (U+00A0) and narrow
    // no-break (U+202F) spaces that Intl.NumberFormat("fr-FR") emits.
    .replace(/\s/g, "")
    .replace(/€/g, "")
    .replace(/eur$/i, "")
    .replace(",", ".");
  if (clean === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const euros = Number(clean);
  if (!Number.isFinite(euros)) return null;
  // round, not trunc: 1200.05 * 100 is 120004.999… in binary, and truncating
  // would drop a cent on every two-decimal entry
  return Math.round(euros * 100);
}

// The frame, as four comparisons preceded by the owner. Isolation lives inside
// the function, not with the caller: a frame without an owner does not compile.
function inBbox(ownerId: string, bbox: Bbox): SQL {
  const box = normalizeBbox(bbox);
  return and(
    eq(targets.ownerId, ownerId),
    gte(targets.lat, box.minLat),
    lte(targets.lat, box.maxLat),
    gte(targets.lng, box.minLng),
    lte(targets.lng, box.maxLng),
  ) as SQL;
}

function contains(bbox: Bbox, point: LatLng): boolean {
  const box = normalizeBbox(bbox);
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lng >= box.minLng &&
    point.lng <= box.maxLng
  );
}

/**
 * Harvests one slice of a sector and says where to resume.
 *
 * Fields (`SURVEY_FIELDS`): `frame` (JSON bbox, required on the first call and
 * ignored afterwards — the archived frame wins), `contour` (optional JSON
 * polygon), `naf` (optional NAF 2008 codes), `label`, and `zoneId` + `page` to
 * resume.
 *
 * The client loops while `result.nextPage` is not null. Next dispatches Server
 * Actions one at a time per client, so a single action chaining a hundred pages
 * would hold the connection for a minute with nothing on screen.
 */
export async function harvestZoneAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  // input echoed back: a refusal must not erase an outline that took ten clicks
  const values: Record<string, string> = {
    frame: field(formData, "frame"),
    contour: field(formData, "contour"),
    naf: field(formData, "naf"),
    label: field(formData, "label"),
    zoneId: field(formData, "zoneId"),
    page: field(formData, "page"),
  };

  // first line of defence: the none/expired billing states and the monthly
  // harvested-targets ceiling. The area ceiling lives in openZone.
  const harvestQuota = await checkQuota("harvest", owner.id);
  if (!harvestQuota.allowed) {
    return fail(previous, harvestQuota.message ?? "Quota reached.", {}, values);
  }

  const pageRaw = field(formData, "page");
  const parsed = surveySchema.safeParse({
    frame: json(formData, "frame"),
    contour: json(formData, "contour"),
    naf: json(formData, "naf"),
    label: field(formData, "label") || null,
    zoneId: field(formData, "zoneId") || null,
    page: pageRaw === "" ? null : Number(pageRaw),
  });

  if (!parsed.success) {
    return fail(
      previous,
      "Unreadable sector. Draw it again on the map.",
      fieldErrorsFrom(parsed.error),
      values,
    );
  }

  const input = parsed.data;

  let zoneId: string;
  let bbox: Bbox;
  let nafCodes: readonly string[];
  let alreadyFound = 0;

  if (input.zoneId) {
    // Resuming without a page would restart at page 1. The upsert is idempotent,
    // but zones.targetsFound would double-count and the sector's reported yield
    // would be wrong.
    if (input.page === null || input.page === undefined) {
      return fail(
        previous,
        "Cannot resume: the resume page is missing.",
        { page: "Give the page to resume from." },
        values,
      );
    }

    const resumed = await resumeZone(owner.id, input.zoneId);
    if (!resumed) {
      return fail(
        previous,
        "This sector is finished or missing. Draw a new one.",
        {},
        values,
      );
    }
    zoneId = resumed.id;
    // the archived frame wins, never the one the client sent back: the map may
    // have moved between slices
    bbox = resumed.bbox;
    nafCodes = resumed.nafCodes;
    alreadyFound = resumed.targetsFound;
  } else {
    if (!input.frame) {
      return fail(
        previous,
        "Draw a sector on the map before surveying it.",
        { frame: "No sector drawn." },
        values,
      );
    }

    const opened = await openZone({
      ownerId: owner.id,
      bbox: input.frame,
      nafCodes: input.naf ?? undefined,
      label: input.label ?? null,
    });

    if ("reason" in opened) {
      // a refusal is an answer, not a failure: it carries the actual area and
      // the ceiling so the user knows how much to tighten
      return fail(previous, opened.message, { frame: opened.message }, values);
    }

    zoneId = opened.zoneId;
    bbox = opened.bbox;
    nafCodes = opened.nafCodes;
  }

  const slice = await harvestSlice({
    ownerId: owner.id,
    zoneId,
    bbox,
    polygon: input.contour ?? null,
    nafCodes,
    startPage: input.page ?? 1,
    alreadyFound,
  });

  const result: SurveyResult = {
    kind: "harvest",
    zoneId: slice.zoneId,
    page: slice.lastPage,
    nextPage: slice.nextPage,
    found: slice.zoneFound,
    created: slice.zoneNew,
    requests: slice.requests,
    totalResults: slice.totalResults,
    truncated: slice.truncated,
    saturated: slice.saturated,
    outsidePolygon: slice.outsidePolygon,
    interrupted: slice.failure !== null,
  };

  refreshTree();

  if (slice.failure) {
    const earned =
      slice.found > 0
        ? `The ${slice.found} businesses already read are saved.`
        : "Nothing was lost.";
    const next = slice.failure.retryable
      ? " Run it again to resume from that page."
      : "";
    return partial(
      previous,
      `${slice.failure.message} Interrupted on page ${slice.failure.page}. ${earned}${next}`,
      result,
    );
  }

  const notes: string[] = [];
  if (slice.outsidePolygon > 0) {
    notes.push(`${slice.outsidePolygon} outside the drawn shape`);
  }
  if (slice.saturated) {
    notes.push("the sector saturates the registry’s 10 000 results, cut it smaller");
  } else if (slice.truncated) {
    notes.push("a ceiling cut in, some businesses are missing");
  }
  const suffix = notes.length > 0 ? ` (${notes.join(" · ")})` : "";

  if (slice.nextPage === null) {
    return done(
      previous,
      `Sector surveyed: ${slice.zoneFound} businesses, ${slice.zoneNew} of them new${suffix}.`,
      result,
    );
  }

  return done(
    previous,
    `Pages ${slice.firstPage} to ${slice.lastPage}: ${slice.zoneFound} businesses, ${slice.zoneNew} of them new${suffix}. Continues on page ${slice.nextPage}.`,
    result,
  );
}

// Enrichment REQUIRES a Google key. Google Places is the only source of a
// website address in the product, and without an address the in-house site
// audit has nothing to read. Everything else — SIRENE harvesting, directors,
// BAN geocoding, the map, scoring, the ledger — still needs no key at all.
//
// Enrichment adds FACTS. It logs nothing and advances nobody: deciding a
// business is "studied" stays a user gesture (advanceTargetAction).

/** What a pass could actually do to one business. */
type EnrichOutcome =
  /** at least one request went out and something was written */
  | { status: "enriched" }
  /** nothing to query: no Google key, and no known website address */
  | { status: "impossible" }
  /** the provider answered badly; nothing was written */
  | { status: "failed"; message: string; fatal: boolean };

async function enrichOne(
  record: Target,
  googleKey: string | null,
  // false when the audit quota is spent: Google facts still land, the audit
  // is skipped, and the selection below excludes audit-only rows so the
  // client loop cannot spin on them.
  auditAllowed = true,
): Promise<EnrichOutcome> {
  const googleOn = googleKey !== null;
  const patch: Partial<NewTarget> = {};
  let attempted = false;

  // the hand-typed address wins over Google: if you typed one, Google's was
  // missing or wrong, and the audit only ever reads siteUrl
  let siteUrl: string | null = record.manualWebsiteUrl ?? record.websiteUrl;
  // True only when Google RECOGNISED the place and reported no website. Google
  // failing to recognise the place says nothing at all.
  let absenceEstablished = false;

  const googleStale =
    record.googleFetchedAt === null || isGoogleDataStale(record.googleFetchedAt);

  if (googleOn && googleStale) {
    const now = new Date();
    try {
      const match = await findPlaceFor({
        name: record.name,
        lat: record.lat,
        lng: record.lng,
        legalName: record.legalName,
        address: record.address,
        postalCode: record.postalCode,
        city: record.city,
      }, { key: googleKey });

      attempted = true;

      // the only place that separates "Google does not know this place" from
      // "Google knows it and it has no site" — opposite facts, same blank screen
      console.info(
        `[google] ${record.siret} ${record.name} → ` +
          (match
            ? `matched ${match.facts.googlePlaceId} · site ${match.facts.websiteUrl ?? "NONE"}`
            : "NO MATCH"),
      );

      // Stamp the ATTEMPT, not the success. Google answered, even if the answer
      // is "unknown place"; without the stamp the row stays forever stale and
      // the loop re-queries it on every pass, and every pass is billed.
      patch.googleFetchedAt = now;

      if (match) {
        patch.googlePlaceId = match.facts.googlePlaceId;
        patch.ratingTenths = match.facts.ratingTenths;
        patch.reviewCount = match.facts.reviewCount;
        patch.priceLevel = match.facts.priceLevel;
        patch.phone = match.facts.phone;
        patch.websiteUrl = match.facts.websiteUrl;
        patch.businessStatus = match.facts.businessStatus;
        patch.openingHours = match.facts.openingHours;

        siteUrl = record.manualWebsiteUrl ?? match.facts.websiteUrl;
        // "no site" only holds when NOBODY knows one, Google or you
        absenceEstablished =
          record.manualWebsiteUrl === null && match.facts.websiteUrl === null;
      } else {
        // No match: the previous facts are orphaned. Keeping them under a fresh
        // timestamp would pass them off as verified when they may describe the
        // shop next door.
        patch.ratingTenths = null;
        patch.reviewCount = null;
        patch.priceLevel = null;
        patch.phone = null;
        patch.websiteUrl = null;
        patch.businessStatus = null;
        patch.openingHours = null;
        // googlePlaceId stays: it is the only field Google's terms allow us to
        // keep indefinitely. The hand-typed address stays too.
        siteUrl = record.manualWebsiteUrl;
        absenceEstablished = false;
      }
    } catch (error) {
      const fatal = error instanceof PlacesError ? !error.retryable : false;
      console.error(`[google] ${record.siret}`, error);
      return {
        status: "failed",
        message:
          error instanceof PlacesError
            ? error.message
            : "Google did not answer.",
        fatal,
      };
    }
  }

  // audit when nothing was ever audited, or when Google just returned an
  // address different from the one the previous audit covered
  const auditPending =
    record.auditedAt === null || (siteUrl !== null && siteUrl !== record.websiteUrl);

  if (auditAllowed && auditPending && siteUrl !== null) {
    attempted = true;
    const facts = await auditSite(siteUrl);
    patch.siteAudit = facts;
    patch.auditedAt = new Date();
  } else if (auditAllowed && auditPending && absenceEstablished) {
    // an OBSERVATION, not a missing attempt: Google knows the place and it has
    // no site
    attempted = true;
    patch.siteAudit = { issue: "no_known_site" };
    patch.auditedAt = new Date();
  }

  // No timestamp when nothing could be attempted. Writing auditedAt would pass
  // the business off as studied when no request ever went out, and would invent
  // the "no site" fact instead of observing it.
  if (!attempted) return { status: "impossible" };

  patch.updatedAt = new Date();
  await db
    .update(targets)
    .set(patch)
    .where(and(eq(targets.ownerId, record.ownerId), eq(targets.id, record.id)));

  return { status: "enriched" };
}

/** The live states: the only ones worth paying Google for. */
const LIVE_STATES: readonly TargetState[] = ["spotted", "studied", "engaged"];

const MESSAGE_NO_KEY =
  "No Google key: enrichment cannot run. Set GOOGLE_PLACES_API_KEY, or add your " +
  "key on the Setup screen instead — that one needs no restart. Google is the " +
  "only source of a website address, and without one the in-house site audit " +
  "has nothing to read. Surveying, directors and the map keep working without it.";

function pendingCondition(googleOn: boolean, auditOn = true): SQL {
  const cutoff = new Date(Date.now() - GOOGLE_FRESHNESS_DAYS * 86_400_000);

  // An audit to run on an address we already hold, served by Google OR typed by
  // hand. Dropping the second would make manual entry useless on a sector
  // enrichment: the row would never become a candidate.
  const auditPending = and(
    isNull(targets.auditedAt),
    or(isNotNull(targets.websiteUrl), isNotNull(targets.manualWebsiteUrl)) as SQL,
  ) as SQL;

  if (!googleOn) return auditPending;

  // Google to (re)query: never asked, or stale.
  const googlePending = or(
    isNull(targets.googleFetchedAt),
    lt(targets.googleFetchedAt, cutoff),
  ) as SQL;

  // audit quota spent: audit-only rows leave the pending set, so the batch
  // loop and its "remaining" count agree and the client never spins.
  if (!auditOn) return googlePending;

  return or(googlePending, auditPending) as SQL;
}

/**
 * Enriches a batch of businesses in the frame, purging expired Google facts
 * first. Field (`ENRICH_ZONE_FIELDS`): `frame`, the JSON bbox. The client
 * re-runs the action while `result.remaining` is not zero.
 */
export async function enrichZoneAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { frame: field(formData, "frame") };
  const parsed = frameSchema.safeParse({ frame: json(formData, "frame") });

  if (!parsed.success) {
    return fail(
      previous,
      "Unreadable frame.",
      fieldErrorsFrom(parsed.error),
      values,
    );
  }

  const googleKey = await getPlacesKey(owner.id);
  if (!googleKey) {
    return fail(previous, MESSAGE_NO_KEY, {}, values);
  }

  const enrichQuota = await checkQuota("enrich", owner.id);
  if (!enrichQuota.allowed) {
    return fail(previous, enrichQuota.message ?? "Quota reached.", {}, values);
  }
  // audits ride enrichment: when their quota is out, enrichment carries on
  // and the audit is simply skipped (see pendingCondition).
  const auditAllowed = (await checkQuota("audit", owner.id)).allowed;

  const bbox = parsed.data.frame;
  const googleOn = true;

  // purge first: it also frees the rows the loop must re-query
  const purged = await purgeStaleGoogleFacts();

  const scope = and(inBbox(owner.id, bbox), inArray(targets.state, [...LIVE_STATES])) as SQL;
  const pending = and(scope, pendingCondition(googleOn, auditAllowed)) as SQL;

  const [candidates, impossibleRows] = await Promise.all([
    db.select().from(targets).where(pending).limit(ENRICH_BATCH_SIZE),
    // Neither queryable nor already audited: counted separately so the client
    // loop does not spin forever on a batch that can never move.
    db
      .select({ total: sql<number>`count(*)` })
      .from(targets)
      .where(
        and(
          scope,
          isNull(targets.auditedAt),
          googleOn
            ? and(
                isNotNull(targets.googleFetchedAt),
                gte(
                  targets.googleFetchedAt,
                  new Date(Date.now() - GOOGLE_FRESHNESS_DAYS * 86_400_000),
                ),
                isNull(targets.websiteUrl),
              )
            : isNull(targets.websiteUrl),
        ),
      ),
  ]);

  const unreachable = Number(impossibleRows[0]?.total ?? 0);

  if (candidates.length === 0) {
    const result: EnrichResult = {
      kind: "enrichment",
      enriched: 0,
      remaining: 0,
      unreachable,
      googleUsed: googleOn,
      purged,
      budgetSpent: false,
    };
    refreshTree();
    return done(previous, describeEnrich(0, 0, unreachable, purged), result);
  }

  const startedAt = Date.now();
  let enriched = 0;
  let budgetSpent = false;
  let failure: { message: string; fatal: boolean } | null = null;

  for (const record of candidates) {
    // checked BEFORE starting, never mid-way: a half-enriched business would be
    // worse than an untouched one
    if (Date.now() - startedAt > ENRICH_TIME_BUDGET_MS) {
      budgetSpent = true;
      break;
    }

    const outcome = await enrichOne(record, googleKey, auditAllowed);
    if (outcome.status === "enriched") enriched += 1;
    if (outcome.status === "failed") {
      failure = { message: outcome.message, fatal: outcome.fatal };
      // A permanent failure (key refused, invalid request) never heals on its
      // own: pressing on would burn quota on the next eleven businesses.
      if (outcome.fatal) break;
    }
  }

  const [remainingRows] = await db
    .select({ total: sql<number>`count(*)` })
    .from(targets)
    .where(pending);
  const remaining = Number(remainingRows?.total ?? 0);

  const result: EnrichResult = {
    kind: "enrichment",
    enriched,
    remaining,
    unreachable,
    googleUsed: googleOn,
    purged,
    budgetSpent,
  };

  refreshTree();

  // nothing enriched AND a failure: reporting success would make the client
  // loop on a batch that will not move
  if (enriched === 0 && failure) {
    return partial(previous, `${failure.message} No record updated.`, result);
  }

  const alert = failure ? ` ${failure.message}` : "";
  return done(
    previous,
    describeEnrich(enriched, remaining, unreachable, purged) + alert,
    result,
  );
}

function describeEnrich(
  enriched: number,
  remaining: number,
  unreachable: number,
  purged: number,
): string {
  const parts: string[] = [];

  if (enriched === 0 && remaining === 0) {
    parts.push("Nothing new to query in this frame.");
  } else {
    parts.push(
      `${enriched} ${enriched > 1 ? "records enriched" : "record enriched"}.`,
    );
    if (remaining > 0) parts.push(`${remaining} still waiting.`);
  }

  if (unreachable > 0) {
    parts.push(
      `${unreachable} with nothing to query: Google does not know these addresses and no website is attached.`,
    );
  }

  if (purged > 0) {
    parts.push(`${purged} records purged (Google data older than 30 days).`);
  }

  return parts.join(" ");
}

/**
 * Enriches ONE business on demand. Field (`ENRICH_TARGET_FIELDS`): `id`.
 * Without a Google key and without a known website address, nothing is written
 * and the message says so.
 */
export async function enrichTargetAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { id: field(formData, "id") };
  const parsed = targetSchema.safeParse({ id: field(formData, "id") });

  if (!parsed.success) {
    return fail(previous, "Business not found.", fieldErrorsFrom(parsed.error), values);
  }

  const [record] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, parsed.data.id)))
    .limit(1);

  if (!record) return fail(previous, "Business not found.", {}, values);

  const googleKey = await getPlacesKey(owner.id);
  if (!googleKey) {
    return fail(previous, MESSAGE_NO_KEY, {}, values);
  }

  const enrichQuota = await checkQuota("enrich", owner.id);
  if (!enrichQuota.allowed) {
    return fail(previous, enrichQuota.message ?? "Quota reached.", {}, values);
  }
  const auditAllowed = (await checkQuota("audit", owner.id)).allowed;

  const purged = await purgeStaleGoogleFacts();
  const outcome = await enrichOne(record, googleKey, auditAllowed);

  // successes are logged too, not just failures: without this line the hosting
  // logs show nothing at all and there is no way to tell whether the action ran
  console.info(
    `[enrich] ${record.siret} ${record.name} → ${outcome.status}` +
      (outcome.status === "failed" ? ` : ${outcome.message}` : "") +
      (purged > 0 ? ` · ${purged} purged` : ""),
  );

  const result: EnrichResult = {
    kind: "enrichment",
    enriched: outcome.status === "enriched" ? 1 : 0,
    remaining: 0,
    unreachable: outcome.status === "impossible" ? 1 : 0,
    googleUsed: true,
    purged,
    budgetSpent: false,
  };

  refreshTree();

  if (outcome.status === "failed") {
    return partial(previous, `${outcome.message} The record is unchanged.`, result);
  }

  if (outcome.status === "impossible") {
    return partial(
      previous,
      "Nothing to query: Google does not know this address and no website is attached. The record is left untouched.",
      result,
    );
  }

  return done(previous, `${record.name}: record enriched.`, result);
}

/**
 * Normalises a hand-typed website address.
 *
 * Without the scheme, `new URL()` throws and the audit would file the row as
 * "site unreachable" — the opposite of "no site", with a different scoring
 * factor. A malformed entry must never become a false observation.
 */
function normalizeSite(raw: string): string | null {
  const cleaned = raw.trim();
  if (cleaned === "") return null;

  const withSchema = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  let url: URL;
  try {
    url = new URL(withSchema);
  } catch {
    return null;
  }

  // A host with no dot is not a domain: "boulangerie" passes new URL (a valid
  // hostname on a local network) and the audit would chase a machine that does
  // not exist.
  if (!url.hostname.includes(".")) return null;

  return url.toString();
}

/**
 * Writes a hand-typed field, or clears it. Fields (`NOTE_FIELDS`): `id`,
 * `field` (`website` | `phone`), `value`.
 *
 * Writing a website address resets `auditedAt` and `siteAudit` to null.
 * Otherwise the audit would never re-run on an already-audited business, and
 * the screen would show the new address above the old address's findings.
 */
export async function noteTargetFieldAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = {
    id: field(formData, "id"),
    field: field(formData, "field"),
    value: field(formData, "value"),
  };

  const parsed = inputSchema.safeParse(values);
  if (!parsed.success) {
    return fail(previous, "Unreadable entry.", fieldErrorsFrom(parsed.error), values);
  }

  const { id, field: which, value } = parsed.data;

  const [record] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, id)))
    .limit(1);
  if (!record) return fail(previous, "Business not found.", {}, values);

  const patch: Partial<NewTarget> = { manualNotedAt: new Date(), updatedAt: new Date() };
  let message: string;

  if (which === "website") {
    const empty = value.trim() === "";
    const url = empty ? null : normalizeSite(value);

    if (!empty && url === null) {
      return fail(
        previous,
        "That is not a readable web address.",
        { value: "Try something like boulangerie-durand.fr" },
        values,
      );
    }

    patch.manualWebsiteUrl = url;

    // nothing to redo if the effective address is unchanged: resetting the
    // audit on a re-entry of the same string would throw away paid-for requests
    const before = record.manualWebsiteUrl ?? record.websiteUrl;
    if ((url ?? record.websiteUrl) !== before) {
      patch.siteAudit = null;
      patch.auditedAt = null;
    }

    message =
      url === null
        ? "Address cleared. Whatever Google returns takes over again."
        : `Address saved. Fetch the facts to run the site audit on it.`;
  } else {
    const phoneNumber = value.trim();
    patch.manualPhone = phoneNumber === "" ? null : phoneNumber;
    message =
      phoneNumber === ""
        ? "Phone cleared."
        : "Phone saved. It counts toward reachability from now on.";
  }

  // nothing hand-typed is left on this record: stamping an entry that clears
  // the last field would date a gesture by its opposite
  if (patch.manualWebsiteUrl === null && patch.manualPhone === null) {
    const remainingOther =
      which === "website" ? record.manualPhone !== null : record.manualWebsiteUrl !== null;
    if (!remainingOther) patch.manualNotedAt = null;
  }

  await db
    .update(targets)
    .set(patch)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, id)));

  refreshTree();
  return done(previous, message, null);
}

// The event follows the state REACHED, not the path taken: jumping straight
// from `spotted` to `engaged` logs a `contact`, which is what happened.
const EVENT_FOR_STATE: Record<
  "studied" | "engaged" | "taken" | "withdrawn",
  EventKind
> = {
  studied: "study",
  engaged: "contact",
  taken: "take",
  withdrawn: "withdrawal",
};

/**
 * Advances a business one step, logs the fact, and returns what to celebrate.
 *
 * Fields (`ADVANCE_FIELDS`): `id`; `to` (`studied` | `engaged` | `taken` |
 * `withdrawn`, ASCII keys); `amount`, the amount ACTUALLY signed in hand-typed
 * euros, required for `taken` and ignored otherwise; `note`, which goes to the
 * ledger only.
 *
 * A take's amount is never deduced from the price grid: the loot is what is at
 * stake (computed), the take is what was banked (entered).
 */
export async function advanceTargetAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values: Record<string, string> = {
    id: field(formData, "id"),
    to: field(formData, "to"),
    amount: field(formData, "amount"),
    note: field(formData, "note"),
  };

  const rawAmount = field(formData, "amount");
  const amountCents = rawAmount === "" ? null : parseEurosToCents(rawAmount);

  if (rawAmount !== "" && amountCents === null) {
    return fail(
      previous,
      "Unreadable amount.",
      { amount: "An amount in euros, for example 3 500 or 3500,00." },
      values,
    );
  }

  const parsed = advanceSchema.safeParse({
    id: field(formData, "id"),
    to: field(formData, "to"),
    amountCents,
    note: field(formData, "note") || null,
  });

  if (!parsed.success) {
    return fail(previous, "Entry refused.", fieldErrorsFrom(parsed.error), values);
  }

  const { id, to, note } = parsed.data;

  const row = await getTargetRow(owner, id);
  if (!row) return fail(previous, "Business not found.", {}, values);

  const from = row.state;

  if (from === "dismissed") {
    return fail(
      previous,
      `${row.name} is set aside. Put it back in play before advancing it.`,
      {},
      values,
    );
  }

  if (from === "taken") {
    return fail(previous, `${row.name} is already taken.`, {}, values);
  }

  if (from === "withdrawn" && to !== "taken") {
    return fail(
      previous,
      `${row.name} is already withdrawn. Only a signature puts it back in play.`,
      {},
      values,
    );
  }

  if (to !== "withdrawn" && TARGET_STATE_RANK[to] <= TARGET_STATE_RANK[from]) {
    return fail(
      previous,
      `${row.name} is already at this step, or beyond. An approach does not go backwards.`,
      {},
      values,
    );
  }

  const kind = EVENT_FOR_STATE[to];

  let valueCents: number | null = null;
  if (to === "taken") {
    if (amountCents === null || amountCents <= 0) {
      return fail(
        previous,
        "Give the amount actually signed: this is the take, not the estimate.",
        { amount: "Amount required for a take." },
        values,
      );
    }
    valueCents = amountCents;
  }

  const now = new Date();

  // The `where` also matches on the state we read, so a double click or two tabs
  // on the same record cannot log the same fact twice: the second write finds no
  // row in the expected state.
  const patch: Partial<NewTarget> = { state: to, updatedAt: now };

  // Set only on a take, and left untouched everywhere else.
  if (to === "taken") patch.capturedAt = now;

  const updated = await db
    .update(targets)
    .set(patch)
    .where(
      and(
        eq(targets.ownerId, owner.id),
        eq(targets.id, id),
        eq(targets.state, from),
      ),
    )
    .returning({ id: targets.id });

  if (updated.length === 0) {
    return fail(
      previous,
      "This business changed state in the meantime. Reopen the record.",
      {},
      values,
    );
  }

  const score: PlaceScore = row.score;

  await db.insert(events).values({
    ownerId: owner.id,
    targetId: id,
    kind,
    valueCents,
    note,
    occurredAt: now,
  });

  const hold = await holdAround(
    owner.id,
    { lat: row.lat, lng: row.lng },
    to === "taken" ? 1 : 0,
  );

  const result: AdvanceResult = {
    kind: "advance",
    targetId: id,
    targetName: row.name,
    from,
    to: to,
    event: kind,
    valueCents,
    // An ESTIMATE from the grid, never a logged amount: events.valueCents holds
    // the one-off take, not the subscription. Off-grid it is null and never
    // zero — "+ 0 €/month" would assert there is no recurring revenue, when
    // off-grid means exactly that it is not priced yet.
    recurringCents: score.price.kind === "grid" ? score.price.recurringCents : null,
    holdBefore: hold.before,
    holdAfter: hold.after,
    zoneLabel: hold.label,
  };

  refreshTree();

  const message =
    to === "taken"
      ? `${row.name} is taken.`
      : to === "withdrawn"
        ? `${row.name}: withdrawal recorded.`
        : `${row.name} moves to “${STATE_LABEL[to]}”.`;

  return done(previous, message, result);
}

/**
 * Removes the LAST fact from the ledger and puts the business back where the
 * remaining ledger places it. Field (`UNDO_FIELDS`): `id`.
 *
 * This is the only deletion of a logged fact in the product: a stray click did
 * not happen, and compensating with a negative entry would leave the `take` in
 * `events` for getBankedTotalCents to keep summing. The landing state comes from
 * `stateFromLedger`, never from stepping back one rank.
 */
export async function rollbackTargetAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { id: field(formData, "id") };
  const parsed = targetSchema.safeParse({ id: field(formData, "id") });

  if (!parsed.success) {
    return fail(previous, "Business not found.", fieldErrorsFrom(parsed.error), values);
  }

  const [record] = await db
    .select({
      id: targets.id,
      name: targets.name,
      state: targets.state,
      capturedAt: targets.capturedAt,
    })
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, parsed.data.id)))
    .limit(1);

  if (!record) return fail(previous, "Business not found.", {}, values);

  if (record.state === "dismissed") {
    // `dismissed` is justified by no fact: it is set by hand and undone by hand.
    // Erasing a fact under it would change nothing visible.
    return fail(
      previous,
      `${record.name} is set aside: its state does not come from the log. Put it back in play first.`,
      {},
      values,
    );
  }

  // Two facts fit in the same `occurred_at`: marking "studied" then "engaged"
  // in the same second is a normal two-click sequence. Without a tie-break the
  // undo would erase the study and leave the call, and the state would not move.
  const [last] = await db
    .select({
      id: events.id,
      kind: events.kind,
      valueCents: events.valueCents,
    })
    .from(events)
    .where(and(eq(events.ownerId, owner.id), eq(events.targetId, record.id)))
    // The SAME order as the ledger, and it comes from the schema: one displays
    // the last fact, the other erases it. Two copied expressions would drift,
    // and the product would erase something other than what it shows.
    .orderBy(...LEDGER_ORDER_DESC)
    .limit(1);

  if (!last) {
    return fail(
      previous,
      `${record.name} has no fact in the log: there is nothing to undo.`,
      {},
      values,
    );
  }

  // A `survey` is not undoable: it was never decided. The harvest logs one per
  // business found, and erasing it would change no state while putting an
  // "Undo" button on every record in the file.
  if (last.kind === "survey") {
    return fail(
      previous,
      `${record.name} has only its spotting in the log, and a spotting cannot be undone: the business really was found. Set it aside if you no longer want to see it.`,
      {},
      values,
    );
  }

  const erased = await db
    .delete(events)
    .where(and(eq(events.ownerId, owner.id), eq(events.id, last.id)))
    .returning({ id: events.id });

  if (erased.length === 0) {
    // two tabs, or a double click: the fact was already undone, and reporting
    // success would return the same progress twice
    return fail(
      previous,
      "This fact was just undone elsewhere. Reopen the record.",
      {},
      values,
    );
  }

  const remainingFacts = await db
    .select({ kind: events.kind })
    .from(events)
    .where(and(eq(events.ownerId, owner.id), eq(events.targetId, record.id)))
    .orderBy(events.occurredAt, events.seq);

  const revertedTo = stateFromLedger(remainingFacts.map((row) => row.kind));

  await db
    .update(targets)
    .set({
      state: revertedTo,
      // leaving capturedAt on a business that is no longer taken would count an
      // erased signature in the banked total; when the state stays `taken` the
      // column already holds the right date
      capturedAt: revertedTo === "taken" ? record.capturedAt : null,
      updatedAt: new Date(),
    })
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, record.id)));

  const result: UndoResult = {
    kind: "undo",
    targetId: record.id,
    targetName: record.name,
    from: record.state,
    to: revertedTo,
    erasedEvent: last.kind,
    erasedValueCents: last.valueCents,
    remainingEvents: remainingFacts.length,
  };

  refreshTree();

  const currencyNote =
    last.valueCents !== null
      ? ` The ${formatEuros(last.valueCents, { decimals: "never" })} take leaves the signed total.`
      : "";

  return done(
    previous,
    `${record.name} goes back to “${STATE_LABEL[revertedTo]}”. The fact was erased from the log.${currencyNote}`,
    result,
  );
}

/**
 * The hold of the sector containing this point, before and after the fact.
 *
 * A sector's frame is stored as JSON, so recent sectors are re-read and tested
 * in TypeScript rather than filtered in SQL. Returns nulls when no sector
 * contains the business, which happens: an address can be worked without a
 * harvest.
 */
async function holdAround(
  ownerId: string,
  point: LatLng,
  delta: number,
): Promise<{ before: number | null; after: number | null; label: string | null }> {
  const rows = await db
    .select()
    .from(zones)
    .where(eq(zones.ownerId, ownerId))
    .orderBy(desc(zones.startedAt))
    .limit(ZONES_FOR_HOLD);

  const zone = rows.find((candidate) => contains(candidate.bbox, point));
  if (!zone) return { before: null, after: null, label: null };

  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      captures: sql<number>`sum(case when ${targets.state} = 'taken' then 1 else 0 end)`,
    })
    .from(targets)
    .where(inBbox(ownerId, zone.bbox));

  const total = Number(counts?.total ?? 0);
  if (total === 0) return { before: null, after: null, label: zone.label };

  const captures = Number(counts?.captures ?? 0);
  return {
    before: Math.round(((captures - delta) / total) * 100),
    after: Math.round((captures / total) * 100),
    label: zone.label,
  };
}

// Dismissing loses nothing and no column remembers the previous state: it is
// rebuilt from the ledger on restore, the same principle as the score. Neither
// dismissing nor restoring logs a fact.

/** The state a logged fact implies. `reply` means `engaged`: they answered. */
const STATE_FOR_EVENT: Record<EventKind, TargetState> = {
  survey: "spotted",
  study: "studied",
  contact: "engaged",
  reply: "engaged",
  take: "taken",
  withdrawal: "withdrawn",
};

function stateFromLedger(kinds: readonly EventKind[]): TargetState {
  // an outcome beats everything before it, and the LAST outcome beats the
  // others: a business lost then won is taken
  for (let index = kinds.length - 1; index >= 0; index -= 1) {
    const kind = kinds[index]!;
    if (kind === "take") return "taken";
    if (kind === "withdrawal") return "withdrawn";
  }

  let best: TargetState = "spotted";
  for (const kind of kinds) {
    const state = STATE_FOR_EVENT[kind];
    if (TARGET_STATE_RANK[state] > TARGET_STATE_RANK[best]) best = state;
  }
  return best;
}

/**
 * Sets a business aside: out of play, never deleted. Field (`DISMISS_FIELDS`):
 * `id`. The row stays so the next harvest does not offer the same address
 * again, and nothing puts it back on the map until it is restored.
 */
export async function dismissTargetAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { id: field(formData, "id") };
  const parsed = targetSchema.safeParse({ id: field(formData, "id") });

  if (!parsed.success) {
    return fail(previous, "Business not found.", fieldErrorsFrom(parsed.error), values);
  }

  const [record] = await db
    .select({ id: targets.id, name: targets.name, state: targets.state })
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, parsed.data.id)))
    .limit(1);

  if (!record) return fail(previous, "Business not found.", {}, values);

  if (record.state === "dismissed") {
    return fail(previous, `${record.name} is already set aside.`, {}, values);
  }

  if (record.state === "taken") {
    // a take would leave the hold denominator: the figure would drop without
    // anything having happened
    return fail(
      previous,
      `${record.name} is a take: it is won and cannot be set aside.`,
      {},
      values,
    );
  }

  await db
    .update(targets)
    .set({ state: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(targets.ownerId, owner.id),
        eq(targets.id, record.id),
        ne(targets.state, "dismissed"),
      ),
    );

  const result: DismissResult = {
    kind: "dismiss",
    targetId: record.id,
    targetName: record.name,
    dismissed: true,
  };

  refreshTree();
  return done(previous, `${record.name} set aside. The log stays intact.`, result);
}

/**
 * Puts a business back in play, in the state its ledger justifies. Field
 * (`DISMISS_FIELDS`): `id`.
 */
export async function restoreTargetAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { id: field(formData, "id") };
  const parsed = targetSchema.safeParse({ id: field(formData, "id") });

  if (!parsed.success) {
    return fail(previous, "Business not found.", fieldErrorsFrom(parsed.error), values);
  }

  const [record] = await db
    .select({ id: targets.id, name: targets.name, state: targets.state })
    .from(targets)
    .where(and(eq(targets.ownerId, owner.id), eq(targets.id, parsed.data.id)))
    .limit(1);

  if (!record) return fail(previous, "Business not found.", {}, values);

  if (record.state !== "dismissed") {
    return fail(previous, `${record.name} is already in play.`, {}, values);
  }

  const ledger = await db
    .select({ kind: events.kind })
    .from(events)
    .where(and(eq(events.ownerId, owner.id), eq(events.targetId, record.id)))
    .orderBy(events.occurredAt, events.seq);

  const restored = stateFromLedger(ledger.map((row) => row.kind));

  await db
    .update(targets)
    .set({ state: restored, updatedAt: new Date() })
    .where(
      and(
        eq(targets.ownerId, owner.id),
        eq(targets.id, record.id),
        eq(targets.state, "dismissed"),
      ),
    );

  const result: DismissResult = {
    kind: "dismiss",
    targetId: record.id,
    targetName: record.name,
    dismissed: false,
  };

  refreshTree();
  return done(
    previous,
    `${record.name} is back on the map, in state “${STATE_LABEL[restored]}”.`,
    result,
  );
}

/**
 * Renames a sector, or clears its name. Fields (`RENAME_FIELDS`): `id`,
 * `label`.
 *
 * The label is only a label: the frame, the businesses and the hold are all
 * counted from `bbox`, so nothing is looked up by name and this action logs
 * nothing and recomputes nothing. An empty label clears the name, which is the
 * only way back after a typo.
 */
export async function renameZoneAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = {
    id: field(formData, "id"),
    label: field(formData, "label"),
  };

  const parsed = renameSchema.safeParse({
    id: field(formData, "id"),
    label: field(formData, "label"),
  });

  if (!parsed.success) {
    return fail(previous, "Name refused.", fieldErrorsFrom(parsed.error), values);
  }

  // field() already trimmed: what is empty here really was, and is stored as
  // null rather than "" — two representations of the same emptiness always drift
  const label = parsed.data.label === "" ? null : parsed.data.label;

  const updated = await db
    .update(zones)
    .set({ label })
    .where(and(eq(zones.ownerId, owner.id), eq(zones.id, parsed.data.id)))
    .returning({ id: zones.id });

  if (updated.length === 0) {
    return fail(previous, "Sector not found.", {}, values);
  }

  const result: SectorResult = {
    kind: "sector",
    zoneId: parsed.data.id,
    label,
  };

  refreshTree();

  return done(
    previous,
    label === null
      ? "Name cleared: the sector goes back to its date."
      : `Sector renamed “${label}”.`,
    result,
  );
}

/**
 * Deletes a sector AND every business found inside its bbox — a target has no
 * foreign key to a zone, membership is geographic, so this is the only way to
 * take the businesses with it. Their events cascade with them via
 * `events.targetId`'s `onDelete: "cascade"`. Both deletes run in one
 * transaction: a sector must never survive without its businesses, or vanish
 * while they linger. There is no undo; `DELETE_ZONE_FIELDS`: `id`.
 */
export async function deleteZoneAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireUser();

  const values = { id: field(formData, "id") };
  const parsed = targetSchema.safeParse(values);

  if (!parsed.success) {
    return fail(previous, "Sector refused.", fieldErrorsFrom(parsed.error), values);
  }

  const [zone] = await db
    .select({ id: zones.id, label: zones.label, bbox: zones.bbox })
    .from(zones)
    .where(and(eq(zones.ownerId, owner.id), eq(zones.id, parsed.data.id)))
    .limit(1);

  if (!zone) {
    return fail(previous, "Sector not found.", {}, values);
  }

  const targetsDeleted = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(targets)
      .where(bboxCondition(owner.id, zone.bbox))
      .returning({ id: targets.id });

    await tx
      .delete(zones)
      .where(and(eq(zones.ownerId, owner.id), eq(zones.id, zone.id)));

    return removed.length;
  });

  const result: DeleteZoneResult = {
    kind: "delete-zone",
    zoneId: zone.id,
    label: zone.label,
    targetsDeleted,
  };

  refreshTree();

  return done(
    previous,
    targetsDeleted > 0
      ? `Sector deleted, along with ${plural(targetsDeleted, "business", "businesses")}.`
      : "Sector deleted.",
    result,
  );
}
