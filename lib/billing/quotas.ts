// Monthly quotas, derived from the data itself: no usage_counters table to
// drift out of sync. `checkQuota` runs first-line in the costly actions; the
// billing page reads the same counts for display. Everything here is inert
// without MOLLIE_API_KEY — `getBillingState` answers "self-hosted" and every
// check passes.

import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";

import { db, targets, zones } from "@/lib/db";
import { areaKm2 } from "@/lib/geo";
import type { Bbox } from "@/lib/types";

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

const KIND_LABEL: Record<QuotaKind, string> = {
  harvest: "businesses harvested",
  enrich: "Google enrichments",
  audit: "site audits",
  area: "km² surveyed",
};

export const MESSAGE_START_TRIAL =
  "Start your free trial on the Billing screen to begin surveying.";

export const MESSAGE_EXPIRED =
  "Your trial or subscription has ended. Subscribe on the Billing screen to " +
  "keep going — everything already surveyed stays readable.";

async function countUsage(
  kind: QuotaKind,
  ownerId: string,
  since: Date | null,
): Promise<number> {
  if (kind === "area") {
    const rows = await db
      .select({ bbox: zones.bbox })
      .from(zones)
      .where(
        since
          ? and(eq(zones.ownerId, ownerId), gte(zones.startedAt, since))
          : eq(zones.ownerId, ownerId),
      );
    return rows.reduce((sum, row) => sum + areaKm2(row.bbox as Bbox), 0);
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
      message: MESSAGE_START_TRIAL,
    };
  }

  if (billing.state === "expired") {
    return {
      allowed: false,
      // all-time count: the billing page still shows what was surveyed.
      used: await countUsage(kind, ownerId, null),
      limit: LIMIT_BY_KIND[kind],
      message: MESSAGE_EXPIRED,
    };
  }

  const used = await countUsage(kind, ownerId, billing.periodStart);
  const limit = LIMIT_BY_KIND[kind];

  if (used < limit) return { allowed: true, used, limit, message: null };

  return {
    allowed: false,
    used,
    limit,
    message:
      `Quota reached: ${Math.round(used)} of ${limit} ${KIND_LABEL[kind]} ` +
      "this period. Manage your plan on the Billing screen.",
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
