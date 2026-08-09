// Subscription state. One row per account (`subscriptions.owner_id` is the
// primary key), written from exactly two places: the /billing actions and the
// Mollie webhook. Everything here is inert without MOLLIE_API_KEY.

import "server-only";

import { eq } from "drizzle-orm";

import { db, subscriptions, type SubscriptionRow } from "@/lib/db";
import type { Account } from "@/lib/accounts";
import type { SubscriptionStatus } from "@/lib/types";

import {
  createCustomer,
  createSubscription,
  getPayment,
  getSubscriptionAtMollie,
  type MolliePayment,
} from "./mollie";
import { PRO_PLAN } from "./plans";

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

// The quota window. A current subscription counts usage from its paid period;
// anyone else counts from the beginning of time, which turns the monthly
// ceiling into the unpaid trial's lifetime ceiling.
export async function getQuotaPeriodStart(
  ownerId: string,
): Promise<Date | null> {
  const row = await getSubscriptionRow(ownerId);
  return isSubscriptionCurrent(row) ? row!.currentPeriodStart : null;
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
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
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

// The webhook body carries only a payment id; fetching it back from Mollie is
// the authentication. Safe to replay: every branch is an idempotent upsert.
export async function applyMolliePayment(paymentId: string): Promise<void> {
  const payment = await getPayment(paymentId);
  const ownerId = await findOwnerId(payment);
  if (!ownerId) return;

  if (payment.status === "paid" && payment.paidAt) {
    const periodStart = new Date(payment.paidAt);
    const periodEnd = addOneMonth(periodStart);

    const row = await getSubscriptionRow(ownerId);

    // First payment carries the mandate: start the recurring subscription one
    // month out, since this payment already covers the first month.
    if (
      payment.sequenceType === "first" &&
      payment.customerId &&
      !row?.mollieSubscriptionId
    ) {
      const created = await createSubscription({
        customerId: payment.customerId,
        ownerId,
        priceCents: PRO_PLAN.priceCents,
        interval: PRO_PLAN.interval,
        description: `Towncenter ${PRO_PLAN.name}`,
        startDate: toDateOnly(periodEnd),
        webhookUrl: mollieWebhookUrl(),
      });
      await upsertSubscription(ownerId, {
        mollieCustomerId: payment.customerId,
        mollieSubscriptionId: created.id,
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
      return;
    }

    await upsertSubscription(ownerId, {
      status: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    return;
  }

  // An unpaid recurring charge: trust Mollie's subscription state, not the
  // payment, and leave the paid period alone — access lapses when it ends.
  if (payment.subscriptionId && payment.customerId) {
    const subscription = await getSubscriptionAtMollie(
      payment.customerId,
      payment.subscriptionId,
    );
    const status: SubscriptionStatus =
      subscription.status === "active" ? "active" : subscription.status;
    await upsertSubscription(ownerId, { status });
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
