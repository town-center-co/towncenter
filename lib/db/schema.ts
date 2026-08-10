// Postgres schema. Nothing computed is stored; the score is recomputed on read.
// `enum` on a `text` column constrains TypeScript only, no CHECK is emitted: the
// `check()` calls below are the only real database constraints.

import { desc, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  EVENT_KINDS,
  SUBSCRIPTION_STATUSES,
  TARGET_STATES,
  TARGET_STATE_RANK,
  USER_ROLES,
  ZONE_STATUSES,
  type Bbox,
  type DirectorFact,
  type EventKind,
  type PriceGrid,
  type SiteAuditFacts,
  type SubscriptionStatus,
  type TargetState,
  type UserRole,
  type ZoneStatus,
} from "@/lib/types";

// Re-exported for server code only: importing this module from a client
// component pulls drizzle and the Postgres driver into the browser bundle.

export {
  EVENT_KINDS,
  SUBSCRIPTION_STATUSES,
  TARGET_STATES,
  TARGET_STATE_RANK,
  USER_ROLES,
  ZONE_STATUSES,
  type EventKind,
  type SubscriptionStatus,
  type TargetState,
  type UserRole,
  type ZoneStatus,
};

export const users = pgTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** Lowercased and trimmed by `lib/accounts.ts`: the unique index compares bytes. */
    email: text("email").notNull(),

    /** `scrypt$N$r$p$salt$digest`. `verifyPassword` refuses an empty hash. */
    passwordHash: text("password_hash").notNull(),

    displayName: text("display_name"),

    /** Instance-level only. Grants no access to another account's data. */
    role: text("role", { enum: USER_ROLES }).notNull().default("member"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    /** Set once the account has been through `/onboarding`; null means still owed the setup. */
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),

    // Sessions signed before this instant are dead. Set on password reset and
    // checked in `getUser()` — never in `proxy.ts`, which has no database and
    // only proves the cookie's signature.
    sessionsInvalidatedAt: timestamp("sessions_invalidated_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    /** The only guard against two simultaneous signups on the same address. */
    uniqueIndex("users_email_key").on(table.email),
  ],
);

export const targets = pgTable(
  "targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    // Tenancy rests on this column and nothing else: no read may leave without
    // `eq(targets.ownerId, ...)`, and `scripts/verify-tenancy.mts` checks it.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    siret: text("siret").notNull(),
    siren: text("siren").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    /** NAF 2008 of the ESTABLISHMENT, not of the company. */
    naf: text("naf"),
    nafLabel: text("naf_label"),

    address: text("address"),
    postalCode: text("postal_code"),
    city: text("city"),
    /** Not amounts: the whole-cents rule does not apply. SIRENE sends strings. */
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),

    /** Open establishments. Past five, the price goes off-grid. */
    establishmentCount: integer("establishment_count"),
    /** `YYYY-MM-DD` as text, never compared in SQL: a `date` would add a timezone. */
    companyCreatedAt: text("company_created_at"),
    employeeRange: text("employee_range"),
    companyCategory: text("company_category"),

    // WHOLE CENTS in `bigint`: a Postgres `integer` is 32-bit and caps at
    // 21 474 836 EUR, which real revenues exceed. `mode: "number"` keeps a JS
    // number. `null` is not zero: `ca: 0` from SIRENE means "accounts not filed".
    revenueCents: bigint("revenue_cents", { mode: "number" }),
    netIncomeCents: bigint("net_income_cents", { mode: "number" }),
    financesYear: integer("finances_year"),

    /** Already filtered of statutory auditors by `lib/sources/sirene.ts`. */
    directors: jsonb("directors")
      .$type<DirectorFact[]>()
      .notNull()
      .default([]),

    // The only Google field storable without a time limit: rating, reviews, price
    // level, phone, website, status and hours EXPIRE AT 30 DAYS and are purged.
    googlePlaceId: text("google_place_id"),
    /** Fetch time, which makes expiry verifiable. Missing means expired. */
    googleFetchedAt: timestamp("google_fetched_at", { withTimezone: true }),
    /** Whole tenths: 46 for 4.6. Never a float. */
    ratingTenths: integer("rating_tenths"),
    reviewCount: integer("review_count"),
    priceLevel: integer("price_level"),
    phone: text("phone"),
    websiteUrl: text("website_url"),
    businessStatus: text("business_status"),
    openingHours: jsonb("opening_hours").$type<{
      openNow?: boolean;
      weekdayDescriptions?: string[];
      periods?: unknown[];
    }>(),

    /** A missing key reads as "unknown"; a `false` is an observation. */
    siteAudit: jsonb("site_audit").$type<SiteAuditFacts>(),
    /** `null` means never audited, which is not "no website". */
    auditedAt: timestamp("audited_at", { withTimezone: true }),

    // Hand-typed values cannot live in `phone` / `website_url`, which
    // `purgeStaleGoogleFacts()` nulls at 30 days. These never expire, stay out
    // of the upsert `set`, and WIN over the Google columns on read.
    manualWebsiteUrl: text("manual_website_url"),
    manualPhone: text("manual_phone"),
    manualNotedAt: timestamp("manual_noted_at", { withTimezone: true }),

    state: text("state", { enum: TARGET_STATES }).notNull().default("spotted"),
    /** Null unless taken. Reading `state` alone would count withdrawals and dismissals too. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    notes: text("notes"),

    harvestedAt: timestamp("harvested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The re-harvest upsert targets this index, on both columns, and its `set`
    // touches only SIRENE columns: never Google, the audit, or the game state.
    uniqueIndex("targets_owner_siret_key").on(table.ownerId, table.siret),

    index("targets_owner_lat_lng_idx").on(table.ownerId, table.lat, table.lng),
    index("targets_owner_state_idx").on(table.ownerId, table.state),
    index("targets_owner_captured_at_idx").on(table.ownerId, table.capturedAt),

    check(
      "targets_rating_range",
      sql`${table.ratingTenths} is null or (${table.ratingTenths} >= 0 and ${table.ratingTenths} <= 50)`,
    ),
    check(
      "targets_review_count_positive",
      sql`${table.reviewCount} is null or ${table.reviewCount} >= 0`,
    ),
    check(
      "targets_price_level_range",
      sql`${table.priceLevel} is null or (${table.priceLevel} >= 1 and ${table.priceLevel} <= 4)`,
    ),
    check("targets_lat_range", sql`${table.lat} >= -90 and ${table.lat} <= 90`),
    check("targets_lng_range", sql`${table.lng} >= -180 and ${table.lng} <= 180`),
  ],
);

export const zones = pgTable(
  "zones",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    label: text("label"),

    /** The box, not the drawn outline: the outline is not stored. */
    bbox: jsonb("bbox").$type<Bbox>().notNull(),

    nafCodes: jsonb("naf_codes").$type<string[]>().notNull().default([]),

    targetsFound: integer("targets_found").notNull().default(0),
    targetsNew: integer("targets_new").notNull().default(0),

    status: text("status", { enum: ZONE_STATUSES }).notNull().default("running"),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("zones_owner_started_at_idx").on(table.ownerId, table.startedAt),
    index("zones_owner_status_idx").on(table.ownerId, table.status),
  ],
);

export const events = pgTable(
  "events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    // Real insertion order. Postgres has no `rowid`, and `occurred_at` is coarse
    // enough for two events to share it, so without `seq` the ledger and the
    // undo silently disagree on which event is the last one.
    seq: bigserial("seq", { mode: "number" }).notNull(),

    // Copied from `targets` so ledger and report reads aggregate without a join.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),

    kind: text("kind", { enum: EVENT_KINDS }).notNull(),

    /** Whole cents. On a `take`, what was signed, not what was estimated. */
    valueCents: integer("value_cents"),

    note: text("note"),

    // `withTimezone` stores an absolute instant; a naked `timestamp` reads back as
    // server-local time.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_target_id_idx").on(table.targetId),
    index("events_owner_occurred_at_idx").on(table.ownerId, table.occurredAt),
    index("events_owner_kind_idx").on(table.ownerId, table.kind),
  ],
);

// One expression, because the ledger DISPLAYS the last event and the undo
// DELETES it. `occurred_at` alone ties, `seq` breaks it by insertion order.
export const LEDGER_ORDER_DESC = [
  desc(events.occurredAt),
  desc(events.seq),
] as const;

// `owner_id` is the primary key: one grid per account at most. A MISSING ROW IS
// NOT AN ERROR, a fresh account plays on `DEFAULT_PRICE_GRID`.

export const priceGrids = pgTable("price_grids", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  /** The whole grid, in WHOLE CENTS. Read back through `readPriceGrid()`. */
  grid: jsonb("grid").$type<PriceGrid>().notNull(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One row per account, like `price_grids`: a missing row means "never went near
// billing". Only written by /billing actions and the Mollie webhook, and only
// meaningful when MOLLIE_API_KEY is set — self-hosted instances never read it.
export const subscriptions = pgTable("subscriptions", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  mollieCustomerId: text("mollie_customer_id"),
  mollieSubscriptionId: text("mollie_subscription_id"),

  planId: text("plan_id").notNull().default("pro"),
  status: text("status", { enum: SUBSCRIPTION_STATUSES })
    .notNull()
    .default("pending"),

  // The paid month. Quota windows start here while the subscription is active;
  // past `currentPeriodEnd` the account falls back to the unpaid ceiling.
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),

  // The card-backed trial. Set when the €0 mandate payment is confirmed;
  // non-null means the account's only trial is consumed. The reminder flag
  // keeps the D-3 email idempotent across `scripts/trial-reminder.mts` runs.
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  trialReminderSentAt: timestamp("trial_reminder_sent_at", {
    withTimezone: true,
  }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Single-use password-reset tokens. Only the SHA-256 of the token is stored: a
// database dump must not let anyone finish a reset. Rows are deleted on use and
// expired ones are purged opportunistically on each new request — no cron here.
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** SHA-256 of the raw token, base64url. The raw token only exists in the email. */
    tokenHash: text("token_hash").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_key").on(table.tokenHash),
    /** The hourly request cap counts on (user_id, created_at). */
    index("password_reset_tokens_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

// Like `price_grids`: one row per account, a missing row plays on the environment's key.
export const accountSettings = pgTable("account_settings", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  googlePlacesKey: text("google_places_key"),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AccountSettings = typeof accountSettings.$inferSelect;
export type NewAccountSettings = typeof accountSettings.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Target = typeof targets.$inferSelect;
export type NewTarget = typeof targets.$inferInsert;
export type Zone = typeof zones.$inferSelect;
export type NewZone = typeof zones.$inferInsert;
export type PriceGridRow = typeof priceGrids.$inferSelect;
export type NewPriceGridRow = typeof priceGrids.$inferInsert;
export type LedgerEvent = typeof events.$inferSelect;
export type NewLedgerEvent = typeof events.$inferInsert;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
