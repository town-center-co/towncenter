// Subscription state. One row per account (`subscriptions.owner_id` is the
// primary key), written from exactly two places: the /billing actions and the
// Mollie webhook. Everything here is inert without MOLLIE_API_KEY.
//
// The hosted lifecycle: signup → `none` (nothing costly allowed) → a €0.00
// first payment captures a card mandate → 14-day trial on full Pro limits,
// with a Mollie subscription scheduled for the trial's end → Mollie charges on
// its own schedule → every paid webhook rolls the month forward. `expired` is
// every dead end at once: trial never converted, suspension, cancellation past
// its period. Data stays readable in every state; only surveying is gated.

import "server-only";

import { eq, sql } from "drizzle-orm";

import type { Account } from "@/lib/accounts";
import { db, subscriptions, users, type SubscriptionRow } from "@/lib/db";
import { appUrl, sendEmail, type EmailContent } from "@/lib/email/resend";
import {
  subscriptionActivatedEmail,
  subscriptionSuspendedEmail,
  trialStartedEmail,
} from "@/lib/email/templates";
import type { SubscriptionStatus } from "@/lib/types";

import {
  createCustomer,
  createSubscription,
  findReusableSubscription,
  getPayment,
  getSubscriptionAtMollie,
  mollieEnabled,
  type MolliePayment,
} from "./mollie";
import { PRO_PLAN, TRIAL_DAYS } from "./plans";

export async function getSubscriptionRow(
  ownerId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

async function upsertSubscription(
  ownerId: string,
  patch: Partial<Omit<SubscriptionRow, "ownerId" | "createdAt">>,
): Promise<void> {
  await db
    .insert(subscriptions)
    .values({ ownerId, ...patch })
    .onConflictDoUpdate({
      target: subscriptions.ownerId,
      set: { ...patch, updatedAt: new Date() },
    });
}

/** Paid through now: `canceled` keeps access until the period runs out. */
export function isSubscriptionCurrent(
  row: SubscriptionRow | null,
  now = new Date(),
): boolean {
  if (!row || !row.currentPeriodEnd) return false;
  if (row.status !== "active" && row.status !== "canceled") return false;
  return row.currentPeriodEnd.getTime() > now.getTime();
}

export type BillingStateKind =
  "self-hosted" | "none" | "trial" | "active" | "expired";

export type BillingState = {
  state: BillingStateKind;
  /** Start of the usage window for `trial` and `active`; null otherwise. */
  periodStart: Date | null;
  row: SubscriptionRow | null;
};

// The one source of truth for what an account may do. Quotas count from
// `periodStart`; `none` and `expired` refuse costly actions outright, and
// `self-hosted` refuses nothing.
export async function getBillingState(
  ownerId: string,
  now = new Date(),
): Promise<BillingState> {
  if (!mollieEnabled()) {
    return { state: "self-hosted", periodStart: null, row: null };
  }

  const row = await getSubscriptionRow(ownerId);
  if (!row) return { state: "none", periodStart: null, row: null };

  // the trial window wins over the subscription status: cancelling during the
  // trial keeps access until its end, exactly like a paid period.
  if (row.trialEndsAt && row.trialEndsAt.getTime() > now.getTime()) {
    return { state: "trial", periodStart: row.currentPeriodStart, row };
  }

  if (isSubscriptionCurrent(row, now)) {
    return { state: "active", periodStart: row.currentPeriodStart, row };
  }

  // a row with neither a consumed trial nor a paid period is an abandoned
  // checkout: the account still owes the mandate.
  if (!row.trialEndsAt && !row.currentPeriodEnd) {
    return { state: "none", periodStart: null, row };
  }

  return { state: "expired", periodStart: null, row };
}

/** Returns the Mollie customer id, creating customer and row on first use. */
export async function ensureMollieCustomer(owner: Account): Promise<string> {
  const row = await getSubscriptionRow(owner.id);
  if (row?.mollieCustomerId) return row.mollieCustomerId;

  const customer = await createCustomer({
    name: owner.displayName ?? owner.email,
    email: owner.email,
    ownerId: owner.id,
  });

  await upsertSubscription(owner.id, { mollieCustomerId: customer.id });
  return customer.id;
}

export async function markSubscriptionPending(ownerId: string): Promise<void> {
  await upsertSubscription(ownerId, { status: "pending" });
}

export async function markSubscriptionCanceled(ownerId: string): Promise<void> {
  await upsertSubscription(ownerId, {
    status: "canceled",
    mollieSubscriptionId: null,
  });
}

function addOneMonth(date: Date): Date {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function findOwnerId(payment: MolliePayment): Promise<string | null> {
  const fromMetadata = payment.metadata?.ownerId;
  if (fromMetadata) return fromMetadata;
  if (!payment.customerId) return null;

  const [row] = await db
    .select({ ownerId: subscriptions.ownerId })
    .from(subscriptions)
    .where(eq(subscriptions.mollieCustomerId, payment.customerId))
    .limit(1);
  return row?.ownerId ?? null;
}

// Lifecycle emails ride the webhook, so they must never fail it: contact
// lookup, link building and sending all stay behind one catch, and sendEmail
// itself never throws.
async function notify(
  ownerId: string,
  build: (contact: {
    email: string;
    displayName: string | null;
  }) => EmailContent,
): Promise<void> {
  try {
    const [contact] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (!contact) return;
    await sendEmail(contact.email, build(contact));
  } catch (error) {
    console.error(
      "[billing] notification failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function billingScreenUrl(): string {
  return new URL("/billing", appUrl()).toString();
}

// The webhook body carries only a payment id; fetching it back from Mollie is
// the authentication. Safe to replay: every branch is an idempotent upsert,
// and every email is guarded by a state transition a replay cannot re-cross.
export async function applyMolliePayment(paymentId: string): Promise<void> {
  const payment = await getPayment(paymentId);
  const ownerId = await findOwnerId(payment);
  if (!ownerId) return;

  // read BEFORE any upsert: the previous status is what decides whether a
  // lifecycle email fires. A replay reads the already-updated row and stays
  // silent.
  const row = await getSubscriptionRow(ownerId);
  const previousStatus: SubscriptionStatus | "none" = row?.status ?? "none";

  // The €0.00 mandate payment: no money moved, the card is now chargeable.
  // The only "first" payments this product creates are those zero-amount
  // captures, so the sequence type is the whole discriminant. Zero-amount
  // card payments may settle as "authorized" rather than "paid".
  if (
    payment.sequenceType === "first" &&
    payment.customerId &&
    (payment.status === "paid" || payment.status === "authorized")
  ) {
    // replay or double delivery: the subscription already exists, done.
    if (row?.mollieSubscriptionId) return;

    const customerId = payment.customerId;
    const mandateAt = payment.paidAt ? new Date(payment.paidAt) : new Date();

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`);
      const [lockedRow] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.ownerId, ownerId))
        .limit(1);
      if (lockedRow?.mollieSubscriptionId) return null;

      const startsTrial = !lockedRow?.trialEndsAt;
      const periodEnd = startsTrial ? addDays(mandateAt, TRIAL_DAYS) : null;
      const created =
        (await findReusableSubscription(customerId, ownerId, payment.id)) ??
        (await createSubscription({
          customerId,
          ownerId,
          priceCents: PRO_PLAN.priceCents,
          interval: PRO_PLAN.interval,
          description: `Towncenter ${PRO_PLAN.name}`,
          startDate: toDateOnly(periodEnd ?? mandateAt),
          webhookUrl: mollieWebhookUrl(),
          mandatePaymentId: payment.id,
        }));

      const patch = startsTrial
        ? {
            mollieCustomerId: customerId,
            mollieSubscriptionId: created.id,
            status: "active" as const,
            currentPeriodStart: mandateAt,
            currentPeriodEnd: periodEnd,
            trialEndsAt: periodEnd,
            trialReminderSentAt: null,
          }
        : {
            mollieCustomerId: customerId,
            mollieSubscriptionId: created.id,
            status: "pending" as const,
          };

      await tx
        .insert(subscriptions)
        .values({ ownerId, ...patch })
        .onConflictDoUpdate({
          target: subscriptions.ownerId,
          set: { ...patch, updatedAt: new Date() },
        });
      return { startsTrial, periodEnd };
    });

    if (result?.startsTrial && result.periodEnd) {
      await notify(ownerId, (contact) =>
        trialStartedEmail({
          name: contact.displayName,
          firstChargeAt: result.periodEnd!,
          billingUrl: billingScreenUrl(),
        }),
      );
    }
    return;
  }

  if (payment.status === "paid" && payment.paidAt) {
    // Real money: a subscription charge. Roll the paid month forward.
    const periodStart = new Date(payment.paidAt);
    const periodEnd = addOneMonth(periodStart);

    const transition = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`);
      const [lockedRow] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.ownerId, ownerId))
        .limit(1);
      if (
        lockedRow?.currentPeriodStart &&
        lockedRow.currentPeriodStart.getTime() >= periodStart.getTime()
      ) {
        return null;
      }

      await tx
        .insert(subscriptions)
        .values({
          ownerId,
          status: "active",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        })
        .onConflictDoUpdate({
          target: subscriptions.ownerId,
          set: {
            status: "active",
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            updatedAt: new Date(),
          },
        });
      return { previousStatus: lockedRow?.status ?? "none" };
    });

    // recovery — after a suspension, an expiry or a cancellation — earns an
    // email; ordinary renewals and replays do not.
    if (transition && transition.previousStatus !== "active") {
      await notify(ownerId, (contact) =>
        subscriptionActivatedEmail({
          name: contact.displayName,
          periodEnd,
        }),
      );
    }
    return;
  }

  // An unpaid recurring charge: trust Mollie's subscription state, not the
  // payment, and leave the paid period alone — access lapses when it ends.
  if (payment.subscriptionId && payment.customerId) {
    const subscription = await getSubscriptionAtMollie(
      payment.customerId,
      payment.subscriptionId,
    );
    const status: SubscriptionStatus = subscription.status;
    const terminal =
      status === "suspended" || status === "canceled" || status === "completed";

    await upsertSubscription(ownerId, {
      status,
      // a dead Mollie subscription must not block the next checkout: the
      // mandate branch above only creates one when this column is empty.
      ...(terminal ? { mollieSubscriptionId: null } : {}),
    });

    if (status === "suspended" && previousStatus !== "suspended") {
      await notify(ownerId, (contact) =>
        subscriptionSuspendedEmail({
          name: contact.displayName,
          billingUrl: billingScreenUrl(),
        }),
      );
    }
  }

  // A first payment that failed or expired stays "pending": /billing offers
  // the checkout again.
}

export function mollieWebhookUrl(): string {
  const base = process.env.APP_URL?.trim();
  if (!base) {
    throw new Error("APP_URL must be set for Mollie webhooks to come back.");
  }
  return new URL("/api/mollie/webhook", base).toString();
}
