// Monthly quotas, derived from the data itself: no usage_counters table to
// drift out of sync. `checkQuota` runs first-line in the costly actions; the
// billing page reads the same counts for display. Everything here is inert
// without MOLLIE_API_KEY — `getBillingState` answers "self-hosted" and every
// check passes.

import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";

import { db, targets } from "@/lib/db";

import { getCumulativeAreaKm2 } from "./area";
import { PRO_PLAN } from "./plans";
import { getBillingState, type BillingState } from "./subscriptions";

export type QuotaKind = "harvest" | "enrich" | "audit" | "area";

export type QuotaStatus = {
  allowed: boolean;
  used: number;
  limit: number;
  /** Set when refused; always ends on a pointer to the Billing screen. */
  message: string | null;
};

const LIMIT_BY_KIND: Record<QuotaKind, number> = {
  harvest: PRO_PLAN.limits.harvestedTargets,
  enrich: PRO_PLAN.limits.enrichments,
  audit: PRO_PLAN.limits.siteAudits,
  area: PRO_PLAN.limits.cumulativeAreaKm2,
};

// Every caller here runs in a real request (a Server Action, a Server
// Component read, or the `verify-actions.mts` bench, which stubs
// `next/headers` with a working session) — never a request-less pure module —
// so `getTranslations()` is always safe to call directly.
export async function quotaStartTrialMessage(): Promise<string> {
  const t = await getTranslations("Quotas");
  return t("startTrial");
}

export async function quotaExpiredMessage(): Promise<string> {
  const t = await getTranslations("Quotas");
  return t("expired");
}

async function countUsage(
  kind: QuotaKind,
  ownerId: string,
  since: Date | null,
): Promise<number> {
  if (kind === "area") {
    return getCumulativeAreaKm2(ownerId, since);
  }

  const column = {
    harvest: targets.harvestedAt,
    enrich: targets.googleFetchedAt,
    audit: targets.auditedAt,
  }[kind];

  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(targets)
    .where(
      since
        ? and(eq(targets.ownerId, ownerId), gte(column, since))
        : and(eq(targets.ownerId, ownerId), gte(column, new Date(0))),
    );
  return Number(row?.total ?? 0);
}

// Split from checkQuota so a caller already holding the BillingState — the
// area check in openZone, the usage summary below — does not re-read it.
export async function checkQuotaWithState(
  kind: QuotaKind,
  ownerId: string,
  billing: BillingState,
): Promise<QuotaStatus> {
  if (billing.state === "self-hosted") {
    return {
      allowed: true,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      message: null,
    };
  }

  if (billing.state === "none") {
    return {
      allowed: false,
      used: 0,
      limit: LIMIT_BY_KIND[kind],
      message: await quotaStartTrialMessage(),
    };
  }

  if (billing.state === "expired") {
    return {
      allowed: false,
      // all-time count: the billing page still shows what was surveyed.
      used: await countUsage(kind, ownerId, null),
      limit: LIMIT_BY_KIND[kind],
      message: await quotaExpiredMessage(),
    };
  }

  const used = await countUsage(kind, ownerId, billing.periodStart);
  const limit = LIMIT_BY_KIND[kind];

  if (used < limit) return { allowed: true, used, limit, message: null };

  const t = await getTranslations("Quotas");
  return {
    allowed: false,
    used,
    limit,
    message: t("reached", { used: Math.round(used), limit, kind }),
  };
}

export async function checkQuota(
  kind: QuotaKind,
  ownerId: string,
): Promise<QuotaStatus> {
  const billing = await getBillingState(ownerId);
  return checkQuotaWithState(kind, ownerId, billing);
}

export type QuotaUsage = Record<QuotaKind, QuotaStatus>;

/** All four counters in one read of the billing state, for /billing. */
export async function getQuotaUsage(ownerId: string): Promise<QuotaUsage> {
  const billing = await getBillingState(ownerId);
  const [harvest, enrich, audit, area] = await Promise.all([
    checkQuotaWithState("harvest", ownerId, billing),
    checkQuotaWithState("enrich", ownerId, billing),
    checkQuotaWithState("audit", ownerId, billing),
    checkQuotaWithState("area", ownerId, billing),
  ]);
  return { harvest, enrich, audit, area };
}
