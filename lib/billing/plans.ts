// The single plan. Intentionally one: the quotas are hard limits, not upsell
// levers, and a price change applies to everyone. Kept out of any "use server"
// module so client components can import the numbers.

import { MAX_CUMULATIVE_AREA_KM2 } from "@/lib/limits";

// Card-backed trial length. The mandate is captured with a €0.00 first
// payment; Mollie runs the first real charge when the trial ends.
export const TRIAL_DAYS = 14;

export const PRO_PLAN = {
  id: "pro",
  name: "Pro",
  priceCents: 1_000,
  /** Mollie interval syntax. */
  interval: "1 month",
  limits: {
    harvestedTargets: 2_500,
    enrichments: 300,
    siteAudits: 100,
    cumulativeAreaKm2: MAX_CUMULATIVE_AREA_KM2,
  },
} as const;

export type Plan = typeof PRO_PLAN;
