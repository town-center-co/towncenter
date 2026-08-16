// Server Action bench: the mutation layer, against a REAL Postgres and with no
// network call at all. Nothing here tests a pure function; app/actions.ts is
// where the money, the ledger and Google's 30-day deadline actually land.
//
//     DATABASE_URL=postgres://… npm run verify:actions
//
// It WRITES, so it CLEANS UP: the test accounts and everything they own are
// deleted at the end, including when an assertion fails, and the bench is
// runnable twice in a row.

import { createHash } from "node:crypto";

import { and, eq, or, sql } from "drizzle-orm";

import { initialActionState } from "@/app/actionState";
import type { ActionState, AdvanceResult, UndoResult } from "@/app/actionState";
import {
  advanceTargetAction,
  dismissTargetAction,
  enrichTargetAction,
  enrichZoneAction,
  harvestZoneAction,
  noteTargetFieldAction,
  renameZoneAction,
  restoreTargetAction,
  rollbackTargetAction,
} from "@/app/actions";
import { subscribeAction } from "@/app/billing/actions";
import { signInAction, signOutAction, signUpAction } from "@/app/login/actions";
import { INITIAL_SIGNIN_STATE, INITIAL_SIGNUP_STATE } from "@/app/login/state";
import {
  resetPriceGridAction,
  savePriceGridAction,
} from "@/app/pricing/actions";
import {
  INITIAL_PRICE_GRID_STATE,
  type PriceGridState,
} from "@/app/pricing/state";
import { getPriceGrid, getTargetDetail, getTargetRow } from "@/app/queries";
import type { Account } from "@/lib/accounts";
import { getSession } from "@/lib/auth";
import {
  db,
  events,
  passwordResetTokens,
  subscriptions,
  targets,
  users,
  zones,
  type NewTarget,
} from "@/lib/db";
import { areaKm2 } from "@/lib/geo";
import { openZone } from "@/lib/harvest";
import { applyMolliePayment } from "@/lib/billing/subscriptions";
import { MAX_CUMULATIVE_AREA_KM2 } from "@/lib/limits";
import { resetPassword } from "@/lib/passwordReset";
import { DEFAULT_PRICE_GRID } from "@/lib/priceGrid";
import { isPlacesConfigured } from "@/lib/sources/places";
import type { Bbox, PriceGrid } from "@/lib/types";

// THE BENCH NEVER CALLS GOOGLE. Removed here rather than merely assumed absent:
// an inherited key would make `npm run verify` bill real requests, and the two
// enrichment actions are worth testing on their refusal path anyway.
delete process.env.GOOGLE_PLACES_API_KEY;

// The acting account is the one the bench gate signed its session for. Asked
// rather than hard-coded, and it is insertable as an id because `users.id` is a
// `text` column.
const session = await getSession();
if (!session) throw new Error("The bench gate handed out no session.");
const SESSION_ID = session.sub;

const EMAIL_LIKE = "bench-actions-%@towncenter.test";

// One line per action call: refresh() only works inside a real Server Action,
// app/actions.ts says so and carries on. Expected here, and it buries the
// assertions.
const report = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[refresh]")) return;
  report(...args);
};

let failures = 0;
let checks = 0;

function check(title: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`✔ ${title.padEnd(58)} ${detail}`);
  } else {
    failures += 1;
    console.error(`✘ ${title.padEnd(58)} ${detail}`);
  }
}

// The test frame, deliberately far OVER the survey area ceiling: a frame small
// enough to be accepted would send the harvest to the SIRENE API.
const FRAME: Bbox = { minLat: 48.0, maxLat: 49.5, minLng: 1.8, maxLng: 2.8 };

const DAY_MS = 86_400_000;
const IDLE: ActionState = initialActionState;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

function advanced(state: ActionState): AdvanceResult | null {
  return state.result?.kind === "advance" ? state.result : null;
}

function undone(state: ActionState): UndoResult | null {
  return state.result?.kind === "undo" ? state.result : null;
}

async function createOwner(key: string, id?: string): Promise<Account> {
  const [row] = await db
    .insert(users)
    .values({
      id,
      email: `bench-actions-${key}@towncenter.test`,
      // A NON-EMPTY hash: the empty string marks an unclaimed account, which
      // `getUser` refuses. It need not be verifiable, no password is presented.
      passwordHash: `scrypt$131072$8$1$YmFuYw==$${key}`,
      displayName: `Bench ${key}`,
      role: "member",
    })
    .returning({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    });

  if (!row) throw new Error(`Test account ${key} was not created.`);
  return row;
}

let siretCounter = 0;

async function seedTarget(
  owner: Account,
  key: string,
  extra: Partial<NewTarget> = {},
): Promise<string> {
  siretCounter += 1;
  const siret = String(90_000_000_000_000 + siretCounter);

  const [row] = await db
    .insert(targets)
    .values({
      ownerId: owner.id,
      siret,
      siren: siret.slice(0, 9),
      name: `Bakery ${key}`,
      lat: 48.88 + siretCounter / 1_000,
      lng: 2.24,
      establishmentCount: 1,
      // written out rather than left to the column default, which a database
      // one migration behind still spells in the old language
      state: "spotted",
      ...extra,
    })
    .returning({ id: targets.id });

  if (!row) throw new Error(`Test target ${key} was not created.`);
  return row.id;
}

async function seedZone(owner: Account, label: string): Promise<string> {
  const [row] = await db
    .insert(zones)
    .values({
      ownerId: owner.id,
      label,
      bbox: FRAME,
      nafCodes: [],
      status: "done",
    })
    .returning({ id: zones.id });

  if (!row) throw new Error("Test sector was not created.");
  return row.id;
}

async function readTarget(id: string) {
  const [row] = await db
    .select()
    .from(targets)
    .where(eq(targets.id, id))
    .limit(1);
  if (!row) throw new Error(`Test target ${id} disappeared.`);
  return row;
}

async function ledgerOf(targetId: string) {
  return db
    .select({ kind: events.kind, valueCents: events.valueCents })
    .from(events)
    .where(eq(events.targetId, targetId))
    .orderBy(events.occurredAt, events.seq);
}

/** Cents to what a keyboard types, without ever dividing money by 100. */
function euros(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const EURO_KEYS = [
  "baseCents",
  "fullSiteCents",
  "multiPageCents",
  "multiAddressCents",
  "perExtraAddressCents",
  "extraAddressCapCents",
  "bookingIntegrationCents",
  "floorCents",
  "ceilingCents",
  "recurringBaseCents",
  "recurringPerExtraAddressCents",
  "recurringCapCents",
] as const;

const COUNT_KEYS = [
  "valueHorizonMonths",
  "maxAddressesInGrid",
  "complexSiteMinPages",
  "fewReviewsForBase",
] as const;

function gridForm(grid: PriceGrid): FormData {
  const data = new FormData();
  for (const key of EURO_KEYS) data.append(key, euros(grid[key]));
  for (const key of COUNT_KEYS) data.append(key, String(grid[key]));
  // entered positive, stored negative: the screen asks for a discount
  data.append("noPhotoCents", euros(-grid.noPhotoCents));
  for (const offer of grid.cappedOffers) data.append("cappedOffers", offer);
  return data;
}

// revalidatePath() throws outside a real Next request, and the pricing actions
// do not wrap it. The row is written before it fires, so the throw stands for
// the state the action was about to return; the rest is asserted on the base.
async function pastRevalidate(
  run: () => Promise<PriceGridState>,
): Promise<PriceGridState> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("revalidatePath")) {
      return { error: null, fields: {}, saved: true };
    }
    throw error;
  }
}

async function cleanup(): Promise<void> {
  await db
    .delete(users)
    .where(
      or(sql`${users.email} like ${EMAIL_LIKE}`, eq(users.id, SESSION_ID)),
    );
}

async function main() {
  console.log("\n=== Server Actions ===\n");

  // a crashed run leaves rows behind; this is what makes the bench repeatable
  await cleanup();

  const actor = await createOwner("actor", SESSION_ID);
  const stranger = await createOwner("stranger");
  const quotaOwner = await createOwner("quota");
  const renewalOwner = await createOwner("renewal");
  const resetOwner = await createOwner("reset");

  check(
    "the bench runs with NO Google key",
    !isPlacesConfigured(),
    "no request can be billed",
  );

  // Concurrent zone requests must serialize the quota read and insertion.
  const quotaBbox: Bbox = {
    minLat: 48,
    maxLat: 48.03,
    minLng: 2,
    maxLng: 2.025,
  };
  const quotaArea = areaKm2(quotaBbox);
  const seededZones = Math.floor(MAX_CUMULATIVE_AREA_KM2 / quotaArea) - 1;
  const quotaStartedAt = new Date(Date.now() - DAY_MS);
  await db.insert(subscriptions).values({
    ownerId: quotaOwner.id,
    status: "active",
    currentPeriodStart: quotaStartedAt,
    currentPeriodEnd: new Date(Date.now() + 28 * DAY_MS),
  });

  const resetToken = "bench-reset-token";
  await db.insert(passwordResetTokens).values({
    userId: resetOwner.id,
    tokenHash: createHash("sha256").update(resetToken).digest("base64url"),
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  const resetOutcomes = await Promise.all([
    resetPassword(resetToken, "New-password-1234"),
    resetPassword(resetToken, "Other-password-5678"),
  ]);
  check(
    "a password-reset token can be redeemed only once",
    resetOutcomes.filter((outcome) => outcome.ok).length === 1,
  );
  await db.insert(zones).values(
    Array.from({ length: seededZones }, (_, index) => ({
      ownerId: quotaOwner.id,
      label: `Quota seed ${index}`,
      bbox: quotaBbox,
      nafCodes: [],
      startedAt: new Date(quotaStartedAt.getTime() + index + 1),
    })),
  );

  const savedMollieKey = process.env.MOLLIE_API_KEY;
  process.env.MOLLIE_API_KEY = "test_bench";
  const concurrentZones = await Promise.all([
    openZone({ ownerId: quotaOwner.id, bbox: quotaBbox }),
    openZone({ ownerId: quotaOwner.id, bbox: quotaBbox }),
  ]);
  if (savedMollieKey === undefined) delete process.env.MOLLIE_API_KEY;
  else process.env.MOLLIE_API_KEY = savedMollieKey;

  const openedZones = concurrentZones.filter((result) => "zoneId" in result);
  const refusedZones = concurrentZones.filter(
    (result) => "reason" in result && result.reason === "surface",
  );
  check(
    "concurrent sectors cannot cross the cumulative area quota",
    openedZones.length === 1 && refusedZones.length === 1,
    `${openedZones.length} opened, ${refusedZones.length} refused`,
  );

  // Two mandate payments racing after a double checkout must create one subscription.
  await db.insert(subscriptions).values({
    ownerId: stranger.id,
    mollieCustomerId: "cst_bench",
    status: "pending",
  });
  await db.insert(subscriptions).values({
    ownerId: renewalOwner.id,
    mollieCustomerId: "cst_renewal_bench",
    mollieSubscriptionId: "sub_renewal_bench",
    status: "suspended",
    currentPeriodStart: new Date("2026-01-01T10:20:30.000Z"),
    currentPeriodEnd: new Date("2026-02-01T10:20:30.000Z"),
  });
  const realFetch = globalThis.fetch;
  const realAppUrl = process.env.APP_URL;
  const realMollieKey = process.env.MOLLIE_API_KEY;
  const mollieSubscriptions: Array<Record<string, unknown>> = [];
  let subscriptionCreates = 0;
  process.env.APP_URL = "https://app.towncenter.test";
  process.env.MOLLIE_API_KEY = "test_bench";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/payments/")) {
      if (url.endsWith("tr_renewal_new") || url.endsWith("tr_renewal_old")) {
        const isNew = url.endsWith("tr_renewal_new");
        return Response.json({
          id: isNew ? "tr_renewal_new" : "tr_renewal_old",
          status: "paid",
          paidAt: isNew
            ? "2026-01-31T10:20:30.000Z"
            : "2026-01-15T10:20:30.000Z",
          customerId: "cst_renewal_bench",
          subscriptionId: "sub_renewal_bench",
          sequenceType: "recurring",
          metadata: { ownerId: renewalOwner.id },
        });
      }
      return Response.json({
        id: url.endsWith("tr_bench_one") ? "tr_bench_one" : "tr_bench_two",
        status: "authorized",
        customerId: "cst_bench",
        sequenceType: "first",
        metadata: { ownerId: stranger.id },
      });
    }
    if (init?.method === "POST" && url.includes("/subscriptions")) {
      subscriptionCreates += 1;
      const body = JSON.parse(String(init.body)) as {
        metadata: Record<string, unknown>;
      };
      const created = {
        id: `sub_bench_${subscriptionCreates}`,
        status: "active",
        metadata: body.metadata,
      };
      mollieSubscriptions.unshift(created);
      return Response.json(created);
    }
    if (url.includes("/subscriptions")) {
      return Response.json({
        _embedded: { subscriptions: mollieSubscriptions },
      });
    }
    throw new Error(`Unexpected Mollie bench request: ${url}`);
  };

  try {
    await Promise.all([
      applyMolliePayment("tr_bench_one"),
      applyMolliePayment("tr_bench_two"),
    ]);
    await applyMolliePayment("tr_renewal_new");
    await applyMolliePayment("tr_renewal_old");
  } finally {
    globalThis.fetch = realFetch;
    if (realAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = realAppUrl;
    if (realMollieKey === undefined) delete process.env.MOLLIE_API_KEY;
    else process.env.MOLLIE_API_KEY = realMollieKey;
  }

  const [billingRow] = await db
    .select({ subscriptionId: subscriptions.mollieSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.ownerId, stranger.id))
    .limit(1);
  check(
    "concurrent mandate webhooks create one Mollie subscription",
    subscriptionCreates === 1 && billingRow?.subscriptionId === "sub_bench_1",
    `${subscriptionCreates} created`,
  );
  const [renewalRow] = await db
    .select({
      periodStart: subscriptions.currentPeriodStart,
      periodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.ownerId, renewalOwner.id))
    .limit(1);
  check(
    "renewals clamp month-end and ignore delayed older payments",
    renewalRow?.periodStart?.toISOString() === "2026-01-31T10:20:30.000Z" &&
      renewalRow.periodEnd?.toISOString() === "2026-02-28T10:20:30.000Z",
  );

  // Google's 30-day deadline. Driven by READS, so no enrichment run is needed:
  // this must come first, `ensureGoogleRetention()` only runs once an hour per
  // process and this is the run that has to be observed.

  const GOOGLE_FACTS = {
    googlePlaceId: "ChIJbench-place-id",
    ratingTenths: 46,
    reviewCount: 128,
    priceLevel: 2,
    phone: "+33 1 23 45 67 89",
    websiteUrl: "https://google-said.example/",
    businessStatus: "OPERATIONAL",
    openingHours: { openNow: true },
  } satisfies Partial<NewTarget>;

  const fetchedAt = new Date(Date.now() - 31 * DAY_MS);
  const expired = await seedTarget(actor, "expired", {
    ...GOOGLE_FACTS,
    googleFetchedAt: fetchedAt,
  });
  const recent = await seedTarget(actor, "recent", {
    ...GOOGLE_FACTS,
    googleFetchedAt: new Date(Date.now() - 29 * DAY_MS),
  });

  const detail = await getTargetDetail(actor, expired);
  const expiredRow = await readTarget(expired);
  const recentRow = await readTarget(recent);

  check(
    "a plain read erases rating, reviews and price level",
    expiredRow.ratingTenths === null &&
      expiredRow.reviewCount === null &&
      expiredRow.priceLevel === null,
    `${expiredRow.ratingTenths} · ${expiredRow.reviewCount} · ${expiredRow.priceLevel}`,
  );
  check(
    "…and phone, website, status and hours",
    expiredRow.phone === null &&
      expiredRow.websiteUrl === null &&
      expiredRow.businessStatus === null &&
      expiredRow.openingHours === null,
    "past 30 days nothing of Google's is kept",
  );
  check(
    "the place id SURVIVES: the only durable field",
    expiredRow.googlePlaceId === GOOGLE_FACTS.googlePlaceId,
    expiredRow.googlePlaceId ?? "erased",
  );
  check(
    "the fetch timestamp SURVIVES: expiry stays verifiable",
    expiredRow.googleFetchedAt?.getTime() === fetchedAt.getTime(),
    expiredRow.googleFetchedAt?.toISOString() ?? "erased",
  );
  check(
    "the read itself shows nothing expired",
    detail !== null &&
      detail.target.googleStale &&
      detail.target.ratingTenths === null &&
      detail.target.phone === null,
    "hidden AND deleted, not one or the other",
  );
  check(
    "a 29-day-old fact is NOT purged",
    recentRow.ratingTenths === 46 &&
      recentRow.phone !== null &&
      recentRow.websiteUrl !== null,
    "the deadline is 30 days, not a mood",
  );

  const recentView = await getTargetRow(actor, recent);
  check(
    "…and it is still displayed",
    recentView !== null &&
      recentView.googleStale === false &&
      recentView.ratingTenths === 46,
    `rating ${recentView?.ratingTenths ?? "none"}`,
  );

  // Amounts: hand-typed euros to INTEGER cents, or a clean refusal.

  const money = await seedTarget(actor, "money");

  const noAmount = await advanceTargetAction(
    IDLE,
    form({ id: money, to: "taken", amount: "" }),
  );
  check(
    "a capture with no amount is refused",
    noAmount.status === "error" && noAmount.fieldErrors.amount !== undefined,
    noAmount.message ?? "",
  );

  const unreadable = await advanceTargetAction(
    IDLE,
    form({ id: money, to: "taken", amount: "beaucoup" }),
  );
  check(
    "an unreadable amount is refused, never NaN",
    unreadable.status === "error" &&
      unreadable.message === "Unreadable amount.",
    unreadable.message ?? "",
  );
  check(
    "a refused amount logs nothing and moves nothing",
    (await ledgerOf(money)).length === 0 &&
      (await readTarget(money)).state === "spotted",
    "still spotted, ledger empty",
  );

  const zeroAmount = await advanceTargetAction(
    IDLE,
    form({ id: money, to: "taken", amount: "0" }),
  );
  check(
    "a capture at 0 € is refused: it is a take, not a gift",
    zeroAmount.status === "error" &&
      zeroAmount.fieldErrors.amount !== undefined,
    zeroAmount.message ?? "",
  );

  // U+202F, the narrow no-break space Intl.NumberFormat("fr-FR") emits and a
  // copy-paste from the screen brings back.
  const pasted = "3\u202f500,00 EUR";
  const taken = await advanceTargetAction(
    IDLE,
    form({ id: money, to: "taken", amount: pasted }),
  );
  const takenResult = advanced(taken);

  check(
    "“3 500,00 EUR” pasted back from the screen is accepted",
    taken.status === "success" && takenResult !== null,
    taken.message ?? "",
  );
  check(
    "…and becomes 350000 WHOLE cents",
    takenResult?.valueCents === 350_000 &&
      Number.isInteger(takenResult?.valueCents),
    `${takenResult?.valueCents} cents`,
  );

  const moneyLedger = await ledgerOf(money);
  check(
    "the ledger stores those integer cents, not a float",
    moneyLedger.length === 1 &&
      moneyLedger[0]?.valueCents === 350_000 &&
      Number.isInteger(moneyLedger[0]?.valueCents),
    `${moneyLedger[0]?.valueCents} cents in the log`,
  );

  const centsTarget = await seedTarget(actor, "cents");
  const withCents = await advanceTargetAction(
    IDLE,
    // U+00A0 this time, and five centimes: the value that a float multiply loses
    form({ id: centsTarget, to: "taken", amount: "1\u00a0200,05 \u20ac" }),
  );
  check(
    "“1 200,05 €” lands on 120005 cents, to the cent",
    advanced(withCents)?.valueCents === 120_005,
    `${advanced(withCents)?.valueCents} cents`,
  );

  // The undo: seq, not occurred_at, decides which fact is the last one.

  const undoTarget = await seedTarget(actor, "undo", { state: "engaged" });
  const sameInstant = new Date();
  await db.insert(events).values({
    ownerId: actor.id,
    targetId: undoTarget,
    kind: "study",
    occurredAt: sameInstant,
  });
  await db.insert(events).values({
    ownerId: actor.id,
    targetId: undoTarget,
    kind: "contact",
    occurredAt: sameInstant,
  });

  const firstUndo = await rollbackTargetAction(IDLE, form({ id: undoTarget }));
  const firstUndoResult = undone(firstUndo);
  const afterFirstUndo = await ledgerOf(undoTarget);

  check(
    "two facts in the same second: the LAST is erased",
    firstUndoResult?.erasedEvent === "contact",
    `erased ${firstUndoResult?.erasedEvent ?? "nothing"}`,
  );
  check(
    "…and the earlier one of that second is untouched",
    afterFirstUndo.length === 1 && afterFirstUndo[0]?.kind === "study",
    afterFirstUndo.map((row) => row.kind).join(" > ") || "empty",
  );
  check(
    "the state follows the REMAINING ledger",
    firstUndoResult?.to === "studied" &&
      (await readTarget(undoTarget)).state === "studied",
    `back to ${firstUndoResult?.to ?? "?"}`,
  );

  const secondUndo = await rollbackTargetAction(IDLE, form({ id: undoTarget }));
  check(
    "undoing again erases the study and empties the log",
    undone(secondUndo)?.to === "spotted" &&
      undone(secondUndo)?.remainingEvents === 0 &&
      (await ledgerOf(undoTarget)).length === 0,
    `back to ${undone(secondUndo)?.to ?? "?"}`,
  );

  const emptyUndo = await rollbackTargetAction(IDLE, form({ id: undoTarget }));
  check(
    "undoing an empty ledger is refused, with a reason",
    emptyUndo.status === "error" &&
      (emptyUndo.message ?? "").includes("nothing to undo"),
    emptyUndo.message ?? "",
  );

  // A ledger whose remaining facts justify something other than the start.
  const capturedAt = new Date(Date.now() - DAY_MS);
  const wonTarget = await seedTarget(actor, "won", {
    state: "withdrawn",
    capturedAt,
  });
  await db.insert(events).values({
    ownerId: actor.id,
    targetId: wonTarget,
    kind: "take",
    valueCents: 350_000,
    occurredAt: sameInstant,
  });
  await db.insert(events).values({
    ownerId: actor.id,
    targetId: wonTarget,
    kind: "withdrawal",
    occurredAt: sameInstant,
  });

  const undoWithdrawal = await rollbackTargetAction(
    IDLE,
    form({ id: wonTarget }),
  );
  const wonRow = await readTarget(wonTarget);
  check(
    "undoing a withdrawal lands on TAKEN, not on the start",
    undone(undoWithdrawal)?.to === "taken" && wonRow.state === "taken",
    `back to ${undone(undoWithdrawal)?.to ?? "?"}`,
  );
  check(
    "a business still taken keeps its capture date",
    wonRow.capturedAt?.getTime() === capturedAt.getTime(),
    wonRow.capturedAt?.toISOString() ?? "erased",
  );

  const undoTake = await rollbackTargetAction(IDLE, form({ id: wonTarget }));
  const afterTakeUndo = await readTarget(wonTarget);
  check(
    "undoing the take clears the capture date and the amount",
    undone(undoTake)?.erasedValueCents === 350_000 &&
      afterTakeUndo.capturedAt === null &&
      afterTakeUndo.state === "spotted",
    `${undone(undoTake)?.erasedValueCents} cents erased`,
  );

  const spottedOnly = await seedTarget(actor, "spotted");
  await db.insert(events).values({
    ownerId: actor.id,
    targetId: spottedOnly,
    kind: "survey",
  });
  const undoSurvey = await rollbackTargetAction(
    IDLE,
    form({ id: spottedOnly }),
  );
  check(
    "a spotting cannot be undone: it really was found",
    undoSurvey.status === "error" && (await ledgerOf(spottedOnly)).length === 1,
    undoSurvey.message ?? "",
  );

  const flow = await seedTarget(actor, "flow");
  const studied = await advanceTargetAction(
    IDLE,
    form({ id: flow, to: "studied", note: "seen from the street" }),
  );
  const studiedResult = advanced(studied);

  check(
    "advancing a step logs the fact",
    studied.status === "success" && studiedResult?.event === "study",
    studied.message ?? "",
  );

  // Idempotence: a double click must double nothing.

  const twice = await advanceTargetAction(
    IDLE,
    form({ id: flow, to: "studied" }),
  );
  check(
    "advancing to the same step twice is refused",
    twice.status === "error" &&
      (twice.message ?? "").includes("already at this step"),
    twice.message ?? "",
  );
  check(
    "…and the ledger still holds ONE fact",
    (await ledgerOf(flow)).length === 1,
    `${(await ledgerOf(flow)).length} fact`,
  );

  const takenTwice = await advanceTargetAction(
    IDLE,
    form({ id: money, to: "taken", amount: "3500" }),
  );
  check(
    "capturing an already-captured business is refused",
    takenTwice.status === "error" &&
      (takenTwice.message ?? "").includes("already taken"),
    takenTwice.message ?? "",
  );
  check(
    "…and the take is still logged once, for the same amount",
    (await ledgerOf(money)).length === 1,
    `${(await ledgerOf(money)).length} take`,
  );

  const dismissCaptured = await dismissTargetAction(IDLE, form({ id: money }));
  check(
    "a captured business cannot be set aside",
    dismissCaptured.status === "error" &&
      (await readTarget(money)).state === "taken",
    dismissCaptured.message ?? "",
  );

  const setAside = await dismissTargetAction(IDLE, form({ id: flow }));
  check(
    "setting aside takes a business out of play",
    setAside.status === "success" &&
      (await readTarget(flow)).state === "dismissed",
    setAside.message ?? "",
  );

  const setAsideTwice = await dismissTargetAction(IDLE, form({ id: flow }));
  check(
    "setting aside twice is refused",
    setAsideTwice.status === "error" &&
      (setAsideTwice.message ?? "").includes("already set aside"),
    setAsideTwice.message ?? "",
  );

  const advanceAside = await advanceTargetAction(
    IDLE,
    form({ id: flow, to: "engaged" }),
  );
  check(
    "a business set aside cannot be advanced",
    advanceAside.status === "error" &&
      (await readTarget(flow)).state === "dismissed",
    advanceAside.message ?? "",
  );

  const undoAside = await rollbackTargetAction(IDLE, form({ id: flow }));
  check(
    "…nor undone: that state comes from no fact",
    undoAside.status === "error" && (await ledgerOf(flow)).length === 1,
    undoAside.message ?? "",
  );

  const restored = await restoreTargetAction(IDLE, form({ id: flow }));
  check(
    "restoring puts it back in the state its ledger justifies",
    restored.status === "success" &&
      (await readTarget(flow)).state === "studied",
    restored.message ?? "",
  );

  const restoredTwice = await restoreTargetAction(IDLE, form({ id: flow }));
  check(
    "restoring twice is refused",
    restoredTwice.status === "error" &&
      (restoredTwice.message ?? "").includes("already in play"),
    restoredTwice.message ?? "",
  );

  // Hand-typed values: they live in the manual_* columns, which no purge touches.

  const noted = await seedTarget(actor, "noted", {
    ...GOOGLE_FACTS,
    googleFetchedAt: new Date(),
    auditedAt: new Date(),
    siteAudit: { issue: "site_ok" },
  });

  const badSite = await noteTargetFieldAction(
    IDLE,
    form({ id: noted, field: "website", value: "boulangerie" }),
  );
  check(
    "a host with no dot is not an address",
    badSite.status === "error" &&
      (await readTarget(noted)).manualWebsiteUrl === null,
    badSite.message ?? "",
  );

  const goodSite = await noteTargetFieldAction(
    IDLE,
    form({ id: noted, field: "website", value: "boulangerie-durand.fr" }),
  );
  const notedRow = await readTarget(noted);
  check(
    "a typed address is normalised into manual_website_url",
    goodSite.status === "success" &&
      notedRow.manualWebsiteUrl === "https://boulangerie-durand.fr/",
    notedRow.manualWebsiteUrl ?? "empty",
  );
  check(
    "…and Google's own column is left alone",
    notedRow.websiteUrl === GOOGLE_FACTS.websiteUrl,
    notedRow.websiteUrl ?? "erased",
  );
  check(
    "a new address resets the audit, or it would never re-run",
    notedRow.auditedAt === null && notedRow.siteAudit === null,
    "auditedAt and siteAudit back to null",
  );

  const phoneNoted = await noteTargetFieldAction(
    IDLE,
    form({ id: noted, field: "phone", value: "01 23 45 67 89" }),
  );
  const phoneRow = await readTarget(noted);
  check(
    "a typed phone lands in manual_phone, not in Google's",
    phoneNoted.status === "success" &&
      phoneRow.manualPhone === "01 23 45 67 89" &&
      phoneRow.phone === GOOGLE_FACTS.phone,
    phoneRow.manualPhone ?? "empty",
  );

  await noteTargetFieldAction(
    IDLE,
    form({ id: noted, field: "website", value: "" }),
  );
  const clearedSite = await readTarget(noted);
  check(
    "clearing the address hands the field back to Google",
    clearedSite.manualWebsiteUrl === null && clearedSite.manualNotedAt !== null,
    "a typed phone remains, so the entry is still dated",
  );

  await noteTargetFieldAction(
    IDLE,
    form({ id: noted, field: "phone", value: "" }),
  );
  const clearedAll = await readTarget(noted);
  check(
    "clearing the phone empties manual_phone, and only it",
    clearedAll.manualPhone === null && clearedAll.phone === GOOGLE_FACTS.phone,
    "a typed value never dies in a Google column",
  );

  // Identifiers: another owner's, an unknown one, and one that is not an id.

  const strangerTarget = await seedTarget(stranger, "stranger");
  const strangerZone = await seedZone(stranger, "Stranger sector");

  const stolenAdvance = await advanceTargetAction(
    IDLE,
    form({ id: strangerTarget, to: "studied" }),
  );
  check(
    "advancing another owner's business is refused",
    stolenAdvance.status === "error" &&
      stolenAdvance.message === "Business not found." &&
      (await ledgerOf(strangerTarget)).length === 0,
    "a guessed id is not enough",
  );

  const stolenDismiss = await dismissTargetAction(
    IDLE,
    form({ id: strangerTarget }),
  );
  const stolenRestore = await restoreTargetAction(
    IDLE,
    form({ id: strangerTarget }),
  );
  const stolenUndo = await rollbackTargetAction(
    IDLE,
    form({ id: strangerTarget }),
  );
  const stolenNote = await noteTargetFieldAction(
    IDLE,
    form({ id: strangerTarget, field: "phone", value: "01 02 03 04 05" }),
  );
  const stolenEnrich = await enrichTargetAction(
    IDLE,
    form({ id: strangerTarget }),
  );

  check(
    "setting aside, restoring and undoing are refused too",
    stolenDismiss.status === "error" &&
      stolenRestore.status === "error" &&
      stolenUndo.status === "error",
    "the same refusal, never a leak",
  );
  check(
    "writing a field on another owner's business is refused",
    stolenNote.status === "error" &&
      (await readTarget(strangerTarget)).manualPhone === null,
    stolenNote.message ?? "",
  );
  check(
    "enriching another owner's business is refused before any key check",
    stolenEnrich.status === "error" &&
      stolenEnrich.message === "Business not found.",
    stolenEnrich.message ?? "",
  );

  const stolenRename = await renameZoneAction(
    IDLE,
    form({ id: strangerZone, label: "Mine now" }),
  );
  const [strangerZoneRow] = await db
    .select({ label: zones.label })
    .from(zones)
    .where(eq(zones.id, strangerZone));
  check(
    "renaming another owner's sector is refused",
    stolenRename.status === "error" &&
      strangerZoneRow?.label === "Stranger sector",
    stolenRename.message ?? "",
  );

  const unknownId = crypto.randomUUID();
  const unknown = await advanceTargetAction(
    IDLE,
    form({ id: unknownId, to: "studied" }),
  );
  check(
    "a well-formed unknown id is refused cleanly",
    unknown.status === "error" &&
      unknown.message === "Business not found." &&
      Object.keys(unknown.fieldErrors).length === 0,
    "it reached the where clause and found nothing",
  );

  const notAnId = await advanceTargetAction(
    IDLE,
    form({ id: "1 or 1=1", to: "studied" }),
  );
  check(
    "a non-UUID is stopped by the schema, before the query",
    notAnId.status === "error" &&
      notAnId.fieldErrors.id === "Unreadable identifier.",
    notAnId.fieldErrors.id ?? "no field error",
  );

  const notAnIdDismiss = await dismissTargetAction(
    IDLE,
    form({ id: "../../etc" }),
  );
  check(
    "…on every action taking an id",
    notAnIdDismiss.status === "error" &&
      notAnIdDismiss.fieldErrors.id === "Unreadable identifier.",
    notAnIdDismiss.fieldErrors.id ?? "no field error",
  );

  // Sectors: renaming, and the survey paths that make no network call.

  const zone = await seedZone(actor, "Bench sector");

  const renamed = await renameZoneAction(
    IDLE,
    form({ id: zone, label: "Rue de la Paix" }),
  );
  const [renamedRow] = await db
    .select({ label: zones.label })
    .from(zones)
    .where(eq(zones.id, zone));
  check(
    "a sector can be renamed",
    renamed.status === "success" && renamedRow?.label === "Rue de la Paix",
    renamedRow?.label ?? "empty",
  );

  await renameZoneAction(IDLE, form({ id: zone, label: "   " }));
  const [clearedZone] = await db
    .select({ label: zones.label })
    .from(zones)
    .where(eq(zones.id, zone));
  check(
    "an empty name is stored as null, never as an empty string",
    clearedZone?.label === null,
    "two spellings of emptiness always drift",
  );

  const noFrame = await harvestZoneAction(IDLE, form({}));
  check(
    "a survey with no sector is refused",
    noFrame.status === "error" && noFrame.fieldErrors.frame !== undefined,
    noFrame.message ?? "",
  );

  const brokenFrame = await harvestZoneAction(IDLE, form({ frame: "{" }));
  check(
    "an unreadable sector is refused",
    brokenFrame.status === "error" &&
      (brokenFrame.message ?? "").startsWith("Unreadable sector"),
    brokenFrame.message ?? "",
  );

  const tooWide = await harvestZoneAction(
    IDLE,
    form({ frame: JSON.stringify(FRAME) }),
  );
  const [zoneTally] = await db
    .select({ total: sql<number>`count(*)` })
    .from(zones)
    .where(eq(zones.ownerId, actor.id));
  check(
    "a sector over the ceiling is refused, with its own area",
    tooWide.status === "error" && (tooWide.message ?? "").includes("km²"),
    tooWide.message ?? "",
  );
  check(
    "…and leaves no sector row behind",
    Number(zoneTally?.total) === 1,
    `${zoneTally?.total} sector, the one seeded`,
  );

  const resumeNoPage = await harvestZoneAction(IDLE, form({ zoneId: zone }));
  check(
    "resuming without a page is refused",
    resumeNoPage.status === "error" &&
      resumeNoPage.fieldErrors.page !== undefined,
    resumeNoPage.message ?? "",
  );

  const resumeDone = await harvestZoneAction(
    IDLE,
    form({ zoneId: zone, page: "2" }),
  );
  check(
    "resuming a finished sector is refused",
    resumeDone.status === "error" &&
      (resumeDone.message ?? "").includes("finished or missing"),
    resumeDone.message ?? "",
  );

  const resumeStranger = await harvestZoneAction(
    IDLE,
    form({ zoneId: strangerZone, page: "2" }),
  );
  check(
    "resuming another owner's sector is refused",
    resumeStranger.status === "error" &&
      (resumeStranger.message ?? "").includes("finished or missing"),
    resumeStranger.message ?? "",
  );

  // Enrichment without a key: a refusal that says what to do, never a throw.

  const enrichFrame = await enrichZoneAction(
    IDLE,
    form({ frame: JSON.stringify(FRAME) }),
  );
  check(
    "enriching a frame without a key refuses cleanly",
    enrichFrame.status === "error" &&
      (enrichFrame.message ?? "").includes("GOOGLE_PLACES_API_KEY"),
    "no throw, no half-written record",
  );
  check(
    "…and the message says what to do about it",
    (enrichFrame.message ?? "").includes("Set GOOGLE_PLACES_API_KEY"),
    enrichFrame.message?.slice(0, 46) ?? "",
  );

  const enrichBadFrame = await enrichZoneAction(
    IDLE,
    form({ frame: "not json" }),
  );
  check(
    "an unreadable frame is refused before the key is even read",
    enrichBadFrame.status === "error" &&
      enrichBadFrame.message === "Unreadable frame.",
    enrichBadFrame.message ?? "",
  );

  const enrichOne = await enrichTargetAction(IDLE, form({ id: noted }));
  check(
    "enriching one business without a key refuses cleanly",
    enrichOne.status === "error" &&
      (enrichOne.message ?? "").includes("GOOGLE_PLACES_API_KEY"),
    "the record is left untouched",
  );

  // The price grid: entered in euros, stored in whole cents, one per account.

  const savedGrid: PriceGrid = {
    ...DEFAULT_PRICE_GRID,
    fullSiteCents: DEFAULT_PRICE_GRID.fullSiteCents * 2,
  };
  const gridFields = gridForm(savedGrid);
  // typed by hand, with the narrow no-break space and a comma
  gridFields.set("baseCents", "2\u202f000,50");

  const saved = await pastRevalidate(() =>
    savePriceGridAction(INITIAL_PRICE_GRID_STATE, gridFields),
  );
  const readBack = await getPriceGrid(actor);

  check(
    "a grid entered in euros is saved",
    saved.saved && saved.error === null,
    saved.error ?? "no error",
  );
  check(
    "…and reads back to the cent, as an integer",
    readBack.baseCents === 200_050 &&
      Number.isInteger(readBack.baseCents) &&
      readBack.fullSiteCents === savedGrid.fullSiteCents,
    `${readBack.baseCents} cents`,
  );
  check(
    "the discount entered positive is stored negative",
    readBack.noPhotoCents === DEFAULT_PRICE_GRID.noPhotoCents,
    `${readBack.noPhotoCents} cents`,
  );

  const brokenGrid = gridForm(savedGrid);
  brokenGrid.set("baseCents", "deux mille");
  const refusedGrid = await pastRevalidate(() =>
    savePriceGridAction(INITIAL_PRICE_GRID_STATE, brokenGrid),
  );
  check(
    "an unreadable amount refuses the whole grid",
    !refusedGrid.saved && refusedGrid.fields.baseCents !== undefined,
    refusedGrid.fields.baseCents ?? "no field error",
  );
  check(
    "…and the saved grid is left as it was",
    (await getPriceGrid(actor)).baseCents === 200_050,
    "nothing half-written",
  );

  const strangerGrid = await getPriceGrid(stranger);
  check(
    "an account that never saved runs on the default grid",
    strangerGrid.fullSiteCents === DEFAULT_PRICE_GRID.fullSiteCents,
    `${strangerGrid.fullSiteCents} cents`,
  );

  const reset = await pastRevalidate(() =>
    resetPriceGridAction(INITIAL_PRICE_GRID_STATE, form({})),
  );
  const afterReset = await getPriceGrid(actor);
  check(
    "resetting drops the row and falls back to the default",
    reset.saved &&
      JSON.stringify(afterReset) === JSON.stringify(DEFAULT_PRICE_GRID),
    "the row is erased, not overwritten with the defaults",
  );

  // The door. No account is created here: every path is a refusal.

  process.env.ALLOW_SIGNUPS = "true";

  const noEmail = await signInAction(
    INITIAL_SIGNIN_STATE,
    form({ password: "x" }),
  );
  check(
    "signing in with no address is refused",
    noEmail.error !== null,
    noEmail.error ?? "",
  );

  const unknownAccount = await signInAction(
    INITIAL_SIGNIN_STATE,
    form({
      email: "bench-actions-nobody@towncenter.test",
      password: "wrong-one-here",
    }),
  );
  const wrongPassword = await signInAction(
    INITIAL_SIGNIN_STATE,
    form({
      email: "bench-actions-actor@towncenter.test",
      password: "wrong-one-here",
    }),
  );
  check(
    "an unknown address and a wrong password get the SAME refusal",
    unknownAccount.error === wrongPassword.error &&
      wrongPassword.error !== null,
    wrongPassword.error ?? "",
  );

  const weakPassword = await signUpAction(
    INITIAL_SIGNUP_STATE,
    form({ email: "bench-actions-weak@towncenter.test", password: "short" }),
  );
  check(
    "a password that fails the shape rules is refused",
    weakPassword.fields.password !== undefined,
    weakPassword.fields.password ?? "",
  );

  const badEmail = await signUpAction(
    INITIAL_SIGNUP_STATE,
    form({ email: "not-an-address", password: "street-by-street-1789" }),
  );
  check(
    "an unreadable address is refused",
    badEmail.fields.email !== undefined,
    badEmail.fields.email ?? "",
  );

  process.env.ALLOW_SIGNUPS = "";
  const closed = await signUpAction(
    INITIAL_SIGNUP_STATE,
    form({
      email: "bench-actions-late@towncenter.test",
      password: "street-by-street-1789",
    }),
  );
  check(
    "the action re-checks the signup gate the page already hid",
    (closed.error ?? "").includes("not accepting new accounts"),
    closed.error ?? "",
  );

  const [strayAccounts] = await db
    .select({ total: sql<number>`count(*)` })
    .from(users)
    .where(sql`${users.email} like ${EMAIL_LIKE}`);
  check(
    "no account was created by any of those refusals",
    Number(strayAccounts?.total) === 5,
    `${strayAccounts?.total} accounts, the five seeded`,
  );

  let termsRequired = false;
  try {
    await subscribeAction(form({}));
  } catch (error) {
    termsRequired =
      error instanceof Error &&
      error.message.includes("redirect(/billing?error=terms)");
  }
  check(
    "billing refuses checkout until professional terms are accepted",
    termsRequired,
    "no Mollie call",
  );

  // requireUser() on the first line: with no valid session every action must end
  // at the door. The gate stub always hands out a cookie, so the secret it was
  // signed with is changed under it, which is what a forged cookie looks like.

  const realSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "a-different-secret-of-at-least-32-characters";

  try {
    const guarded: readonly [string, () => Promise<unknown>][] = [
      [
        "harvestZoneAction",
        () => harvestZoneAction(IDLE, form({ frame: JSON.stringify(FRAME) })),
      ],
      [
        "enrichZoneAction",
        () => enrichZoneAction(IDLE, form({ frame: JSON.stringify(FRAME) })),
      ],
      [
        "enrichTargetAction",
        () => enrichTargetAction(IDLE, form({ id: noted })),
      ],
      [
        "noteTargetFieldAction",
        () =>
          noteTargetFieldAction(
            IDLE,
            form({ id: noted, field: "phone", value: "06" }),
          ),
      ],
      [
        "advanceTargetAction",
        () => advanceTargetAction(IDLE, form({ id: flow, to: "engaged" })),
      ],
      [
        "rollbackTargetAction",
        () => rollbackTargetAction(IDLE, form({ id: flow })),
      ],
      [
        "dismissTargetAction",
        () => dismissTargetAction(IDLE, form({ id: flow })),
      ],
      [
        "restoreTargetAction",
        () => restoreTargetAction(IDLE, form({ id: flow })),
      ],
      [
        "renameZoneAction",
        () => renameZoneAction(IDLE, form({ id: zone, label: "Nope" })),
      ],
      [
        "savePriceGridAction",
        () =>
          savePriceGridAction(INITIAL_PRICE_GRID_STATE, gridForm(savedGrid)),
      ],
      [
        "resetPriceGridAction",
        () => resetPriceGridAction(INITIAL_PRICE_GRID_STATE, form({})),
      ],
    ];

    for (const [name, run] of guarded) {
      let sentToTheDoor = false;
      try {
        await run();
      } catch (error) {
        sentToTheDoor =
          error instanceof Error && error.message.includes("redirect(/login)");
      }
      check(
        `${name} refuses without a session`,
        sentToTheDoor,
        "sent to /login",
      );
    }

    let signedOut = false;
    try {
      await signOutAction();
    } catch (error) {
      signedOut =
        error instanceof Error && error.message.includes("redirect(/login)");
    }
    check("signOutAction always ends at the door", signedOut, "sent to /login");
  } finally {
    process.env.AUTH_SECRET = realSecret;
  }

  const [survivors] = await db
    .select({ total: sql<number>`count(*)` })
    .from(events)
    .where(and(eq(events.ownerId, actor.id), eq(events.targetId, flow)));
  check(
    "a session-less call wrote nothing at all",
    Number(survivors?.total) === 1 &&
      (await readTarget(flow)).state === "studied",
    "the ledger is where it was",
  );

  await cleanup();
}

main()
  .then(async () => {
    if (failures === 0) {
      console.log(`\n✔ The mutation layer holds. ${checks} checks.\n`);
      process.exit(0);
    }
    console.error(`\n✘ ${failures} failure(s) out of ${checks} checks.\n`);
    process.exit(1);
  })
  .catch(async (error) => {
    console.error("\n✘ The bench failed:", error);
    // Cleanup must run EVEN on an exception, otherwise the next run starts on
    // leftover test accounts.
    try {
      await cleanup();
    } catch {
      // The database may be unreachable: that is already what failed.
    }
    process.exit(1);
  });
