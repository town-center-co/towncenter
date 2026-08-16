// Multi-tenancy bench. This is the only bench whose failure is a data leak: the
// others check that the product COMPUTES correctly, this one checks that it does
// not SHOW someone else's file. Typing catches a missing owner PARAMETER; nothing
// catches a missing `where` inside a function body except this file.
//
// It runs against a REAL Postgres, never a stub: a stub returning empty arrays
// would pass every assertion below, including on a completely broken product.
//
//     DATABASE_URL=postgres://… npm run verify:tenancy
//
// It WRITES, so it CLEANS UP: the test accounts and everything they own are
// deleted at the end, including when an assertion fails.

import { eq, sql } from "drizzle-orm";

import {
  getBillingFacts,
  getOnboardingFacts,
  getBankedTotalCents,
  getPriceGrid,
  getOutcomeCount,
  getTargetDetail,
  getTargetRow,
  getZoneStats,
  listFront,
  listJournal,
  listTargetsInBbox,
  listZones,
} from "@/app/queries";
import type { Account } from "@/lib/accounts";
import { createAccount, signupState, verifyCredentials } from "@/lib/accounts";
import {
  accountSettings,
  db,
  events,
  passwordResetTokens,
  priceGrids,
  subscriptions,
  targets,
  users,
  zones,
} from "@/lib/db";
import { DEFAULT_PRICE_GRID } from "@/lib/priceGrid";
import { getAccountPlacesKey, savePlacesKey } from "@/lib/settings";
import type { Bbox, PriceGrid } from "@/lib/types";

// The bench opens signups for itself: it signs one account up at the end, and on
// a database that already holds accounts signups are closed exactly as in
// production. Set in this process only; it touches neither the repo nor the hosting.
process.env.ALLOW_SIGNUPS = "true";
process.env.AUTH_SECRET ??= "towncenter-bench-secret-at-least-32-characters";

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

/** The test frame: wide enough to contain everything the bench writes. */
const FRAME: Bbox = { minLat: 48.0, maxLat: 49.5, minLng: 1.8, maxLng: 2.8 };

/** A test account, inserted directly: this bench tests the READS. */
async function createOwner(key: string): Promise<Account> {
  const [row] = await db
    .insert(users)
    .values({
      email: `bench-${key}@towncenter.test`,
      // A NON-EMPTY hash: `getUser` refuses a row without one. It need not be
      // verifiable, these accounts never sign in.
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

/** Seeds a target, its sector and one event, for a given owner. */
async function seedGround(
  owner: Account,
  siret: string,
): Promise<{ targetId: string }> {
  const [target] = await db
    .insert(targets)
    .values({
      ownerId: owner.id,
      siret,
      siren: siret.slice(0, 9),
      name: `Bakery ${owner.displayName}`,
      lat: 48.88,
      lng: 2.24,
      establishmentCount: 1,
      state: "taken",
      capturedAt: new Date(),
    })
    .returning({ id: targets.id });

  if (!target) throw new Error("Test target was not created.");

  await db.insert(zones).values({
    ownerId: owner.id,
    label: `Sector ${owner.displayName}`,
    bbox: FRAME,
    nafCodes: [],
    status: "done",
  });

  await db.insert(events).values({
    ownerId: owner.id,
    targetId: target.id,
    kind: "take",
    valueCents: 350_000,
  });

  return { targetId: target.id };
}

/** A target still in play, OUTSIDE `FRAME`, for the reads that ignore the frame. */
async function seedInPlay(owner: Account, siret: string): Promise<string> {
  const [target] = await db
    .insert(targets)
    .values({
      ownerId: owner.id,
      siret,
      siren: siret.slice(0, 9),
      name: `Florist ${owner.displayName}`,
      lat: 47.1,
      lng: 1.1,
      establishmentCount: 1,
      state: "studied",
    })
    .returning({ id: targets.id });

  if (!target) throw new Error("Test target still in play was not created.");
  return target.id;
}

async function main() {
  console.log("\n=== Multi-tenancy ===\n");

  const alice = await createOwner("alice");
  const bob = await createOwner("bob");

  // THE SAME SIRET for both: this is the NORMAL case, two salespeople working
  // the same town. Were uniqueness global, the second insert would fail here and
  // the first person to survey a street would lock everyone else out of it.
  const SIRET = "12345678900011";
  const atAlice = await seedGround(alice, SIRET);
  const atBob = await seedGround(bob, SIRET);

  check(
    "the same SIRET holds for two owners",
    atAlice.targetId !== atBob.targetId,
    SIRET,
  );

  // Frame reads

  const aliceFrame = await listTargetsInBbox(alice, FRAME);
  const bobFrame = await listTargetsInBbox(bob, FRAME);

  check(
    "listTargetsInBbox returns only its own targets",
    aliceFrame.rows.length === 1 && bobFrame.rows.length === 1,
    `alice ${aliceFrame.rows.length} · bob ${bobFrame.rows.length}`,
  );
  check(
    "listTargetsInBbox: the total is per owner too",
    aliceFrame.total === 1 && bobFrame.total === 1,
    `alice ${aliceFrame.total} · bob ${bobFrame.total}`,
  );
  check(
    "the returned targets carry the right owner",
    aliceFrame.rows[0]?.id === atAlice.targetId &&
      bobFrame.rows[0]?.id === atBob.targetId,
  );

  // The target sheet: reading by IDENTIFIER is the most exposed path.

  const stolenSheet = await getTargetRow(bob, atAlice.targetId);
  check(
    "getTargetRow refuses another owner's target",
    stolenSheet === null,
    "a guessed id is not enough",
  );

  // The control for the refusal above: a read that returns null to everyone
  // would pass it.
  const ownSheet = await getTargetRow(alice, atAlice.targetId);
  check("getTargetRow does return its own", ownSheet?.id === atAlice.targetId);

  const stolenDetail = await getTargetDetail(bob, atAlice.targetId);
  check("getTargetDetail refuses another owner's target", stolenDetail === null);

  const cleanDetail = await getTargetDetail(alice, atAlice.targetId);
  check(
    "getTargetDetail does return its own",
    cleanDetail !== null && cleanDetail.target.id === atAlice.targetId,
  );
  check(
    "a sheet's neighbourhood does not count another owner's neighbours",
    // Bob's target sits at the SAME point as Alice's: without tenancy it would
    // show up as an immediate neighbour.
    cleanDetail !== null && cleanDetail.neighbours.length === 0,
    `${cleanDetail?.neighbours.length ?? -1} neighbour(s)`,
  );

  // Totals: this is where a leak reads in euros.

  const statsAlice = await getZoneStats(alice, FRAME);
  check(
    "getZoneStats counts for one owner only",
    statsAlice.total === 1 && statsAlice.capturedCents === 350_000,
    `${statsAlice.total} target · ${statsAlice.capturedCents} c`,
  );

  const bankedAlice = await getBankedTotalCents(alice);
  check(
    "getBankedTotalCents does not add up another owner's captures",
    bankedAlice.cents === 350_000 && bankedAlice.captures === 1,
    `${bankedAlice.cents} c · ${bankedAlice.captures} capture`,
  );

  const outcomesAlice = await getOutcomeCount(alice);
  check(
    "getOutcomeCount only calibrates on its own outcomes",
    outcomesAlice === 1,
    `n = ${outcomesAlice}`,
  );

  // Ledger and sectors

  const aliceLog = await listJournal(alice);
  check(
    "listJournal returns only its own events",
    aliceLog.length === 1 && aliceLog[0]?.targetId === atAlice.targetId,
    `${aliceLog.length} row`,
  );

  const aliceSectors = await listZones(alice);
  check(
    "listZones returns only its own sectors",
    aliceSectors.length === 1 &&
      aliceSectors[0]?.label === `Sector ${alice.displayName}`,
    `${aliceSectors.length} sector`,
  );
  check(
    "a sector's hold does not count another owner's targets",
    aliceSectors[0]?.surveyed === 1,
    `${aliceSectors[0]?.surveyed ?? -1} surveyed`,
  );

  // listFront only offers targets STILL IN PLAY, and the two seeded above are
  // taken: without one target each the list is empty for everybody and the
  // refusal below holds on nothing. They sit outside FRAME so the frame counts
  // stay at one.
  const aliceInPlay = await seedInPlay(alice, "12345678900022");
  const bobInPlay = await seedInPlay(bob, "12345678900022");

  const aliceFront = await listFront(alice);
  check(
    "listFront offers its own target still in play",
    aliceFront.length === 1 && aliceFront[0]?.target.id === aliceInPlay,
    `${aliceFront.length} line`,
  );
  check(
    "listFront does not offer another owner's target",
    aliceFront.every(
      (row) => row.target.id !== atBob.targetId && row.target.id !== bobInPlay,
    ),
  );

  // A fresh account sees NOTHING, not even a falsely zeroed total.

  const fresh = await createOwner("fresh");
  const freshFrame = await listTargetsInBbox(fresh, FRAME);
  const bankedFresh = await getBankedTotalCents(fresh);

  check(
    "a fresh account sees an empty territory",
    freshFrame.rows.length === 0 &&
      freshFrame.total === 0 &&
      bankedFresh.cents === 0,
    "0 target · 0 c",
  );

  // Ledger order: Postgres has no `rowid`, hence the `seq` column.

  const [targetOrder] = await db
    .insert(targets)
    .values({
      ownerId: fresh.id,
      siret: "99999999900011",
      siren: "999999999",
      name: "Order",
      lat: 48.88,
      lng: 2.24,
    })
    .returning({ id: targets.id });

  if (targetOrder) {
    // TWO events at the SAME timestamp: what `seq` has to break, and it happens
    // as soon as a sheet is read and a call is made right after.
    const sameInstant = new Date();
    await db.insert(events).values({
      ownerId: fresh.id,
      targetId: targetOrder.id,
      kind: "study",
      occurredAt: sameInstant,
    });
    await db.insert(events).values({
      ownerId: fresh.id,
      targetId: targetOrder.id,
      kind: "contact",
      occurredAt: sameInstant,
    });

    const log = await listJournal(fresh, { targetId: targetOrder.id });
    check(
      "two events in the same second: the LAST written comes first",
      log[0]?.kind === "contact" && log[1]?.kind === "study",
      `${log.map((l) => l.kind).join(" > ")}`,
    );
  }

  // Price grid: one per account, and the default otherwise.

  {
    // Bob sets himself a grid twice as expensive. Alice saved nothing, so she
    // MUST stay on the default grid rather than inherit Bob's.
    const bobGrid: PriceGrid = {
      ...DEFAULT_PRICE_GRID,
      fullSiteCents: DEFAULT_PRICE_GRID.fullSiteCents * 2,
    };
    await db
      .insert(priceGrids)
      .values({ ownerId: bob.id, grid: bobGrid })
      .onConflictDoUpdate({
        target: priceGrids.ownerId,
        set: { grid: bobGrid },
      });

    const bobGridRead = await getPriceGrid(bob);
    const aliceGridRead = await getPriceGrid(alice);

    check(
      "the grid saved by an account is the one it reads back",
      bobGridRead.fullSiteCents === DEFAULT_PRICE_GRID.fullSiteCents * 2,
      `${bobGridRead.fullSiteCents} c`,
    );
    check(
      "an account with no grid does NOT pick up another's",
      aliceGridRead.fullSiteCents === DEFAULT_PRICE_GRID.fullSiteCents,
      `alice stays on the default: ${aliceGridRead.fullSiteCents} c`,
    );

    // The displayed price must follow its own owner's grid. This is the only
    // check proving the whole read path - query, context, scoring - carries the
    // right account.
    const bobView = await listTargetsInBbox(bob, FRAME);
    const bobPrice = bobView.rows[0]?.score.price.priceCents ?? 0;
    const aliceView = await listTargetsInBbox(alice, FRAME);
    const alicePrice = aliceView.rows[0]?.score.price.priceCents ?? 0;

    check(
      "the displayed price follows the target owner's grid",
      bobPrice > alicePrice,
      `bob ${bobPrice} c > alice ${alicePrice} c`,
    );
  }

  // Account settings: one row per account, and a missing row is the normal state.

  {
    const placesKey = "AIzaSyB-bob-secret";
    await savePlacesKey(bob.id, placesKey);

    const [storedSetting] = await db
      .select({ key: accountSettings.googlePlacesKey })
      .from(accountSettings)
      .where(eq(accountSettings.ownerId, bob.id))
      .limit(1);

    const bobFacts = await getOnboardingFacts(bob);
    const aliceFacts = await getOnboardingFacts(alice);

    check(
      "an account key is encrypted at rest",
      Boolean(storedSetting?.key) && storedSetting?.key !== placesKey,
      storedSetting?.key?.startsWith("enc:v1.") ? "sealed" : "not sealed",
    );
    check(
      "the encrypted account key decrypts for server use",
      (await getAccountPlacesKey(bob.id)) === placesKey,
    );

    check(
      "the key saved by an account is the one it reads back",
      bobFacts.placesKeySource === "account" && bobFacts.placesKeyMask !== null,
      `bob source ${bobFacts.placesKeySource}`,
    );
    check(
      "an account with no key does NOT pick up another's",
      aliceFacts.placesKeySource === null && aliceFacts.placesKeyMask === null,
      `alice source ${aliceFacts.placesKeySource}`,
    );
  }

  // Subscriptions: one row per account, read only through getBillingFacts.

  {
    // The key gates the read; a bench value turns it on WITHOUT any Mollie
    // call — getBillingFacts only touches the database.
    const savedKey = process.env.MOLLIE_API_KEY;
    process.env.MOLLIE_API_KEY = "test_bench";

    const periodStart = new Date(Date.now() - 24 * 3600 * 1000);
    const periodEnd = new Date(Date.now() + 27 * 24 * 3600 * 1000);
    await db
      .insert(subscriptions)
      .values({
        ownerId: bob.id,
        mollieCustomerId: "cst_bench_bob",
        mollieSubscriptionId: "sub_bench_bob",
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })
      .onConflictDoUpdate({
        target: subscriptions.ownerId,
        set: { status: "active" },
      });

    const bobBilling = await getBillingFacts(bob);
    const aliceBilling = await getBillingFacts(alice);

    check(
      "the subscription saved by an account is the one it reads back",
      bobBilling.status === "active" && bobBilling.current,
      `bob status ${bobBilling.status}`,
    );
    check(
      "an account with no subscription does NOT pick up another's",
      aliceBilling.status === "none" && !aliceBilling.current,
      `alice status ${aliceBilling.status}`,
    );

    if (savedKey === undefined) delete process.env.MOLLIE_API_KEY;
    else process.env.MOLLIE_API_KEY = savedKey;
  }

  // The cascade: deleting an account takes its territory with it.

  // A pending reset token must not survive its account either: an orphaned hash
  // would let a deleted account's email finish a reset onto a recycled id.
  await db.insert(passwordResetTokens).values({
    userId: bob.id,
    tokenHash: "bench-hash-bob",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  await db.delete(users).where(eq(users.id, bob.id));

  const [remainingTargets] = await db
    .select({ total: sql<number>`count(*)` })
    .from(targets)
    .where(eq(targets.ownerId, bob.id));
  const [remainingEvents] = await db
    .select({ total: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.ownerId, bob.id));
  const [remainingSectors] = await db
    .select({ total: sql<number>`count(*)` })
    .from(zones)
    .where(eq(zones.ownerId, bob.id));
  const [remainingSubscriptions] = await db
    .select({ total: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.ownerId, bob.id));
  const [remainingResetTokens] = await db
    .select({ total: sql<number>`count(*)` })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, bob.id));

  check(
    "deleting an account takes targets, sectors, events, subscription and reset tokens",
    Number(remainingTargets?.total) === 0 &&
      Number(remainingEvents?.total) === 0 &&
      Number(remainingSectors?.total) === 0 &&
      Number(remainingSubscriptions?.total) === 0 &&
      Number(remainingResetTokens?.total) === 0,
    "Postgres cascade, no pragma",
  );

  // Alice lost nothing: an over-reaching cascade would be worse than none.
  const afterAlice = await listTargetsInBbox(alice, FRAME);
  check(
    "one account's cascade does not touch another's territory",
    afterAlice.rows.length === 1,
    `${afterAlice.rows.length} target`,
  );

  // Signing up: the INSERT is the only write on this path, so an address already
  // taken must come back as a field error, never as a thrown constraint.

  const SIGNUP_EMAIL = "bench-signup@towncenter.test";
  const SIGNUP_PASSWORD = "street-by-street";

  const signup = await createAccount({
    email: SIGNUP_EMAIL,
    password: SIGNUP_PASSWORD,
  });

  check(
    "a signup creates an account that can sign in",
    signup.ok &&
      (await verifyCredentials(SIGNUP_EMAIL, SIGNUP_PASSWORD))?.id ===
        signup.account.id,
    signup.ok ? signup.account.id : "signup refused",
  );

  const again = await createAccount({
    email: SIGNUP_EMAIL,
    password: SIGNUP_PASSWORD,
  });

  check(
    "an address already taken is a field error, not a crash",
    !again.ok && again.field === "email",
    again.ok ? "a second account was created" : again.message,
  );

  const savedAllowSignups = process.env.ALLOW_SIGNUPS;
  const savedSaas = process.env.NEXT_PUBLIC_SAAS;
  process.env.ALLOW_SIGNUPS = "";
  process.env.NEXT_PUBLIC_SAAS = "true";
  const saasSignup = await signupState();
  check(
    "SaaS mode keeps signup open without the self-hosted override",
    saasSignup.open && !saasSignup.isFirstAccount,
    saasSignup.reason || "open",
  );
  if (savedAllowSignups === undefined) delete process.env.ALLOW_SIGNUPS;
  else process.env.ALLOW_SIGNUPS = savedAllowSignups;
  if (savedSaas === undefined) delete process.env.NEXT_PUBLIC_SAAS;
  else process.env.NEXT_PUBLIC_SAAS = savedSaas;

  // Cleanup

  await db
    .delete(users)
    .where(sql`${users.email} like 'bench-%@towncenter.test'`);
}

main()
  .then(async () => {
    if (failures === 0) {
      console.log(`\n✔ Tenancy holds. ${checks} checks.\n`);
      process.exit(0);
    }
    console.error(`\n✘ ${failures} leak(s) out of ${checks} checks.\n`);
    process.exit(1);
  })
  .catch(async (error) => {
    console.error("\n✘ The bench failed:", error);
    // Cleanup must run EVEN on an exception, otherwise the next run starts on
    // leftover test accounts.
    try {
      await db
        .delete(users)
        .where(sql`${users.email} like 'bench-%@towncenter.test'`);
    } catch {
      // The database may be unreachable: that is already what failed.
    }
    process.exit(1);
  });
