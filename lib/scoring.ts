// Scoring of a harvested address: what price we would quote, and how likely we
// are to sell it.
// Pure module: no network, no database, no React, no clock (the reference date
// arrives through the context). Scores are recomputed on every read, never
// stored in a column.
// The probability is a PRODUCT of factors, never a weighted sum: a sum would
// dilute the disqualifying signals into the average.

import { formatEuros, formatPercent } from "@/lib/format";

import type {
  LootReason,
  PlaceScore,
  PriceAdjustment,
  PriceEstimate,
  PriceGrid,
  PriceOffer,
  ProximityFact,
  ScoringContext,
  ScoringFacts,
  SiteAuditFacts,
  SuccessEstimate,
  SuccessFactor,
} from "./types";
import { CALIBRATION_MIN_OUTCOMES } from "./types";

import { DEFAULT_PRICE_GRID } from "@/lib/priceGrid";

// the price grid is DATA (`lib/priceGrid.ts`, table `price_grids`) and arrives
// through `ScoringContext.grid`. A missing row is the normal case for a fresh
// account, which falls back on `DEFAULT_PRICE_GRID`. Everything below belongs
// to the model: one value per factor family, and a family that knows nothing
// returns 1 so ignorance never penalises.
export const BASE_PROBABILITY = 0.15;

export const REASON_INSTAGRAM = 1.8;
export const REASON_SITE_DATED = 1.5;
export const REASON_NO_SITE = 1.4;
export const REASON_SITE_DECENT = 0.5;
export const REASON_SITE_PRO = 0.15;

/** https, viewport, filled title, structured data, usable photos. */
export const SITE_PRO_MIN_MARKS = 5;

export const SITE_STALE_MONTHS = 36;

export const CAPACITY_STRONG = 1.6;
export const CAPACITY_GOOD = 1.3;
export const CAPACITY_AVERAGE = 1;
export const CAPACITY_WEAK = 0.7;
export const CAPACITY_LOW = 0.5;

export const REVENUE_COMFORTABLE_CENTS = 50_000_000;
export const REVENUE_GOOD_CENTS = 25_000_000;
export const REVENUE_LOW_CENTS = 10_000_000;

// SIRENE serves a single filed year, anywhere from 2015 on, so a stale one must
// not be read as today's capacity.
export const FINANCES_MAX_AGE_YEARS = 3;

export const REVIEWS_PER_YEAR_HIGH = 60;
export const REVIEWS_PER_YEAR_GOOD = 25;
export const REVIEWS_PER_YEAR_AVERAGE = 10;

export const HEADCOUNT_HIGH = 10;
export const HEADCOUNT_GOOD = 3;

export const REACH_DIRECTOR = 1.3;
export const REACH_PHONE = 1.2;
export const REACH_FORM = 0.6;
export const REACH_NONE = 0.3;

export const PROXIMITY_FACTORS: Record<ProximityFact, number> = {
  "same-street-capture": 1.8,
  "near-live-deal": 1.4,
  "in-zone": 1,
  "outside-zone": 0.7,
};

export const AGE_YOUNG = 1.3;
export const AGE_ESTABLISHED = 0.8;
export const AGE_YOUNG_MONTHS = 18;
export const AGE_ESTABLISHED_YEARS = 15;

export const FRANCHISE_PENALTY = 0.15;

export const PROBABILITY_FLOOR = 0.02;
export const PROBABILITY_CEILING = 0.85;

// the displayed percentage is never shown with a decimal, and never below 5 %
// except on an absolute disqualifier.
export const PERCENT_ROUNDING_STEP = 5;

function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth())
  );
}

/** From a `YYYY-MM-DD` string. `null` when missing or unreadable. */
function ageInMonths(day: string | null, reference: Date): number | null {
  if (!day) return null;
  const parsed = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const months = monthsBetween(parsed, reference);
  return months < 0 ? 0 : months;
}

// INSEE employee band code to a lower bound on headcount. `NN` (not filed) and
// unknown codes return null, so the caller falls through to the next signal.
function employeeFloor(range: string | null): number | null {
  if (!range) return null;
  const floors: Record<string, number> = {
    "00": 0,
    "01": 1,
    "02": 3,
    "03": 6,
    "11": 10,
    "12": 20,
    "21": 50,
    "22": 100,
    "31": 200,
    "32": 250,
    "41": 500,
    "42": 1000,
    "51": 2000,
    "52": 5000,
    "53": 10000,
  };
  return floors[range.trim()] ?? null;
}

function addressCount(facts: ScoringFacts): number {
  const count = facts.openEstablishmentCount;
  if (count === null || !Number.isFinite(count) || count < 1) return 1;
  return Math.floor(count);
}

function qualityMarkCount(site: SiteAuditFacts): number {
  const marks = [
    site.https,
    site.viewport,
    site.titleFilled,
    site.structuredData,
    site.usablePhotos,
  ];
  return marks.filter((mark) => mark === true).length;
}

function isComplexSite(site: SiteAuditFacts | null, grid: PriceGrid): boolean {
  if (!site) return false;
  if (site.onlineBooking === true) return true;
  return (site.sitemapUrlCount ?? 0) >= grid.complexSiteMinPages;
}

// pick an offer, adjust it, clamp it. The two off-grid exits return zero
// amounts, so callers must read `kind` before the amounts: an off-grid target
// is not a zero-value target.
export function estimatePrice(
  facts: ScoringFacts,
  grid: PriceGrid = DEFAULT_PRICE_GRID,
): PriceEstimate {
  const site = facts.site;
  const addresses = addressCount(facts);
  const knownAddresses = facts.openEstablishmentCount;

  if (knownAddresses !== null && knownAddresses > grid.maxAddressesInGrid) {
    return outOfGrid(
      "by-quote",
      `${knownAddresses} open establishments: the scope can only be quoted after seeing it, and the decision is not taken at the counter.`,
      "reasonTooManyAddresses",
      { count: knownAddresses },
    );
  }

  if (site?.onlineSales === true) {
    return outOfGrid(
      "to-qualify",
      "Online sales detected: this is no longer a storefront but a shop — different work, different price. To qualify by voice.",
      "reasonOnlineSales",
    );
  }

  let offer: PriceOffer;
  let base: number;
  let reason: string;
  let reasonKey: string;
  let reasonParams: Record<string, string | number> | undefined;

  if (addresses >= 2) {
    offer = "multi-address";
    base = grid.multiAddressCents;
    reason = `${addresses} addresses to cover: one page per location and a structure that holds up.`;
    reasonKey = "reasonMultiAddress";
    reasonParams = { count: addresses };
  } else if (isComplexSite(site, grid)) {
    offer = "multi-page";
    base = grid.multiPageCents;
    if (site?.onlineBooking === true) {
      reason = "Online booking to rebuild: this is no longer a storefront, it is a journey.";
      reasonKey = "reasonOnlineBooking";
    } else {
      reason = `At least ${grid.complexSiteMinPages} pages: design weighs more than integration.`;
      reasonKey = "reasonManyPages";
      reasonParams = { minPages: grid.complexSiteMinPages };
    }
  } else if (
    facts.reviewCount !== null &&
    facts.reviewCount < grid.fewReviewsForBase &&
    site?.usablePhotos === false
  ) {
    offer = "base";
    base = grid.baseCents;
    reason =
      "One address, few reviews, no usable photo: the base tier is enough, and that is what makes it sellable.";
    reasonKey = "reasonBaseTier";
  } else {
    offer = "full-site";
    base = grid.fullSiteCents;
    reason = "One address, a complete site: the offer that sells most often.";
    reasonKey = "reasonFullSite";
  }

  const adjustments: PriceAdjustment[] = [];

  if (offer === "multi-address" && addresses > 2) {
    const amount = Math.min(
      grid.perExtraAddressCents * (addresses - 2),
      grid.extraAddressCapCents,
    );
    adjustments.push({
      label: `${addresses - 2} extra address${addresses - 2 > 1 ? "es" : ""}`,
      key: "extraAddresses",
      params: { count: addresses - 2 },
      amountCents: amount,
    });
  }

  if (site?.onlineBooking === true && offer !== "multi-page") {
    adjustments.push({
      label: "Booking to integrate",
      key: "bookingIntegration",
      amountCents: grid.bookingIntegrationCents,
    });
  }

  if (site?.usablePhotos === false && offer !== "base") {
    adjustments.push({
      label: "No usable photo",
      key: "noUsablePhoto",
      amountCents: grid.noPhotoCents,
    });
  }

  const adjusted =
    base + adjustments.reduce((sum, item) => sum + item.amountCents, 0);

  let priceCents = Math.max(grid.floorCents, adjusted);
  if (grid.cappedOffers.includes(offer)) {
    priceCents = Math.min(grid.ceilingCents, priceCents);
  }

  const recurringCents = Math.min(
    grid.recurringCapCents,
    grid.recurringBaseCents + grid.recurringPerExtraAddressCents * (addresses - 1),
  );

  return {
    kind: "grid",
    offer,
    priceCents,
    recurringCents,
    value12MonthsCents: priceCents + grid.valueHorizonMonths * recurringCents,
    reason,
    reasonKey,
    reasonParams,
    adjustments,
  };
}

function outOfGrid(
  offer: PriceOffer,
  reason: string,
  reasonKey: string,
  reasonParams?: Record<string, string | number>,
): PriceEstimate {
  return {
    kind: "off-grid",
    offer,
    priceCents: 0,
    recurringCents: 0,
    value12MonthsCents: 0,
    reason,
    reasonKey,
    reasonParams,
    adjustments: [],
  };
}

// order matters: the first branch that applies wins. A null `site` means the
// audit never ran, which is not the same fact as "no website".
function reasonFactor(site: SiteAuditFacts | null, reference: Date): SuccessFactor {
  if (!site) {
    return { label: "Reason: site never audited", key: "reasonNeverAudited", value: 1 };
  }
  if (site.agencyDetected === true) {
    return {
      label: "Reason: agency already in place",
      key: "reasonAgencyInPlace",
      value: REASON_SITE_PRO,
    };
  }
  if (site.instagramAsSite === true) {
    return {
      label: "Reason: Instagram used as a website",
      key: "reasonInstagram",
      value: REASON_INSTAGRAM,
    };
  }
  if (site.issue === "no_known_site") {
    return { label: "Reason: no known website", key: "reasonNoSite", value: REASON_NO_SITE };
  }
  if (site.issue === "site_unreachable") {
    return {
      label: "Reason: site unreachable, inconclusive",
      key: "reasonSiteUnreachable",
      value: 1,
    };
  }
  if (site.defaultTheme === true) {
    return {
      label: "Reason: default theme never touched",
      key: "reasonDefaultTheme",
      value: REASON_SITE_DATED,
    };
  }

  const modified = site.lastModified
    ? new Date(site.lastModified)
    : null;
  const modifiedKnown = modified !== null && !Number.isNaN(modified.getTime());
  const staleMonths = modifiedKnown ? monthsBetween(modified, reference) : null;

  if (staleMonths !== null && staleMonths >= SITE_STALE_MONTHS) {
    return { label: "Reason: visibly dated site", key: "reasonDatedSite", value: REASON_SITE_DATED };
  }

  // a missing snapshot is an absence of signal, never proof of upkeep.
  const upkeepProven = staleMonths !== null && staleMonths < SITE_STALE_MONTHS;
  if (qualityMarkCount(site) >= SITE_PRO_MIN_MARKS && upkeepProven) {
    return {
      label: "Reason: professional site, maintained",
      key: "reasonProSite",
      value: REASON_SITE_PRO,
    };
  }

  return { label: "Reason: site is fine", key: "reasonSiteFine", value: REASON_SITE_DECENT };
}

// three fallbacks in order: recent revenue, employee band, footfall from
// reviews. A stale revenue falls through instead of concluding.
function capacityFactor(facts: ScoringFacts, reference: Date): SuccessFactor {
  const financesAge =
    facts.financesYear !== null ? reference.getFullYear() - facts.financesYear : null;
  const financesUsable =
    facts.revenueCents !== null &&
    facts.revenueCents > 0 &&
    (financesAge === null || financesAge <= FINANCES_MAX_AGE_YEARS);

  if (financesUsable && facts.revenueCents !== null) {
    const revenue = facts.revenueCents;
    const year = facts.financesYear ? ` (${facts.financesYear})` : "";
    if (revenue >= REVENUE_COMFORTABLE_CENTS) {
      return {
        label: `Capacity: comfortable revenue${year}`,
        key: "capacityRevenue",
        params: { level: "comfortable", year },
        value: CAPACITY_STRONG,
      };
    }
    if (revenue >= REVENUE_GOOD_CENTS) {
      return {
        label: `Capacity: solid revenue${year}`,
        key: "capacityRevenue",
        params: { level: "solid", year },
        value: CAPACITY_GOOD,
      };
    }
    if (revenue >= REVENUE_LOW_CENTS) {
      return {
        label: `Capacity: average revenue${year}`,
        key: "capacityRevenue",
        params: { level: "average", year },
        value: CAPACITY_AVERAGE,
      };
    }
    return {
      label: `Capacity: low revenue${year}`,
      key: "capacityRevenue",
      params: { level: "low", year },
      value: CAPACITY_LOW,
    };
  }

  const headcount = employeeFloor(facts.employeeRange);
  if (headcount !== null) {
    if (headcount >= HEADCOUNT_HIGH) {
      return {
        label: `Capacity: ${headcount} employees or more`,
        key: "capacityEmployeesOrMore",
        params: { headcount },
        value: CAPACITY_STRONG,
      };
    }
    if (headcount >= HEADCOUNT_GOOD) {
      return {
        label: `Capacity: ${headcount} employees or more`,
        key: "capacityEmployeesOrMore",
        params: { headcount },
        value: CAPACITY_GOOD,
      };
    }
    if (headcount >= 1) {
      return {
        label: "Capacity: one or two employees",
        key: "capacityOneOrTwoEmployees",
        value: CAPACITY_AVERAGE,
      };
    }
    return { label: "Capacity: no employees", key: "capacityNoEmployees", value: CAPACITY_WEAK };
  }

  const reviews = facts.reviewCount;
  if (reviews === null || reviews <= 0) {
    return { label: "Capacity: unknown", key: "capacityUnknown", value: 1 };
  }

  // footfall is a RATE; without a known age the raw total stands in for it.
  const months = ageInMonths(facts.companyCreatedAt, reference);
  const years = months !== null && months >= 12 ? months / 12 : null;
  const perYear = years !== null ? reviews / years : reviews;

  let value: number;
  let label: string;
  let level: "heavy" | "good" | "moderate" | "light";
  if (perYear >= REVIEWS_PER_YEAR_HIGH) {
    value = CAPACITY_STRONG;
    label = "Capacity: heavy footfall";
    level = "heavy";
  } else if (perYear >= REVIEWS_PER_YEAR_GOOD) {
    value = CAPACITY_GOOD;
    label = "Capacity: good footfall";
    level = "good";
  } else if (perYear >= REVIEWS_PER_YEAR_AVERAGE) {
    value = CAPACITY_AVERAGE;
    label = "Capacity: moderate footfall";
    level = "moderate";
  } else {
    value = CAPACITY_WEAK;
    label = "Capacity: light footfall";
    level = "light";
  }

  let ticket: "none" | "high" | "small" = "none";
  if (facts.priceLevel !== null && facts.priceLevel >= 3 && value < CAPACITY_STRONG) {
    value = value === CAPACITY_GOOD ? CAPACITY_STRONG : CAPACITY_GOOD;
    label = `${label}, high ticket`;
    ticket = "high";
  } else if (facts.priceLevel === 1 && value > CAPACITY_WEAK) {
    value = value === CAPACITY_STRONG ? CAPACITY_GOOD : CAPACITY_WEAK;
    label = `${label}, small ticket`;
    ticket = "small";
  }

  return { label, key: "capacityFootfall", params: { level, ticket }, value };
}

function reachabilityFactor(facts: ScoringFacts): SuccessFactor {
  if (facts.directorCount > 0) {
    return { label: "Reachability: director named", key: "reachabilityDirector", value: REACH_DIRECTOR };
  }
  if (facts.hasPhone) {
    return { label: "Reachability: direct phone line", key: "reachabilityPhone", value: REACH_PHONE };
  }
  if (facts.hasContactForm) {
    return { label: "Reachability: contact form only", key: "reachabilityForm", value: REACH_FORM };
  }
  return { label: "Reachability: no contact at all", key: "reachabilityNone", value: REACH_NONE };
}

function proximityFactor(facts: ScoringFacts): SuccessFactor {
  const labels: Record<ProximityFact, string> = {
    "same-street-capture": "Proximity: same street as a signed deal",
    "near-live-deal": "Proximity: within 300 m of a live lead",
    "in-zone": "Proximity: inside the sector",
    "outside-zone": "Proximity: outside the sector",
  };
  const keys: Record<ProximityFact, string> = {
    "same-street-capture": "proximitySameStreet",
    "near-live-deal": "proximityNearLiveDeal",
    "in-zone": "proximityInZone",
    "outside-zone": "proximityOutsideZone",
  };
  return {
    label: labels[facts.proximity],
    key: keys[facts.proximity],
    value: PROXIMITY_FACTORS[facts.proximity],
  };
}

function ageFactor(facts: ScoringFacts, reference: Date): SuccessFactor {
  const months = ageInMonths(facts.companyCreatedAt, reference);
  if (months === null) {
    return { label: "Age: unknown", key: "ageUnknown", value: 1 };
  }
  if (months < AGE_YOUNG_MONTHS) {
    return { label: "Age: under 18 months", key: "ageUnder18Months", value: AGE_YOUNG };
  }
  if (months >= AGE_ESTABLISHED_YEARS * 12) {
    return { label: "Age: over 15 years", key: "ageOver15Years", value: AGE_ESTABLISHED };
  }
  return { label: "Age: established", key: "ageEstablished", value: 1 };
}

// a closed establishment and an exercised right to object return a hard zero
// and bypass the 2 % floor: the floor bounds uncertainty, not impossibility.
export function estimateSuccess(
  facts: ScoringFacts,
  context: ScoringContext = { outcomeCount: 0 },
): SuccessEstimate {
  const reference = context.now ? new Date(context.now) : new Date();
  const base = context.baseProbability ?? BASE_PROBABILITY;
  const n = Math.max(0, Math.floor(context.outcomeCount));
  const calibrated = n >= CALIBRATION_MIN_OUTCOMES;

  const factors: SuccessFactor[] = [{ label: "Base rate", key: "baseRate", value: base }];

  if (!facts.isOpen) {
    factors.push({ label: "Disqualifier: establishment closed", key: "disqualifierClosed", value: 0 });
    return { probability: 0, rawProbability: 0, percent: 0, factors, calibrated, n };
  }
  if (!facts.isDiffusible) {
    factors.push({ label: "Disqualifier: opt-out right exercised", key: "disqualifierOptOut", value: 0 });
    return { probability: 0, rawProbability: 0, percent: 0, factors, calibrated, n };
  }

  factors.push(reasonFactor(facts.site, reference));
  factors.push(capacityFactor(facts, reference));
  factors.push(reachabilityFactor(facts));
  factors.push(proximityFactor(facts));
  factors.push(ageFactor(facts, reference));

  if (facts.isFranchiseGroupSite) {
    factors.push({
      label: "Disqualifier: franchise on a group website",
      key: "disqualifierFranchise",
      value: FRANCHISE_PENALTY,
    });
  }

  // the raw value ORDERS, the clamped one DISPLAYS: collapsing both onto the
  // 2 % floor would sort the bottom of the file by price instead.
  const rawProbability = factors.reduce((product, factor) => product * factor.value, 1);
  const probability = Math.min(
    PROBABILITY_CEILING,
    Math.max(PROBABILITY_FLOOR, rawProbability),
  );

  const percent = Math.max(
    PERCENT_ROUNDING_STEP,
    Math.round((probability * 100) / PERCENT_ROUNDING_STEP) * PERCENT_ROUNDING_STEP,
  );

  return { probability, rawProbability, percent, factors, calibrated, n };
}

// the expectancy uses `rawProbability`, clamped to 1 because a product of
// factors can exceed it. It is zero on an off-grid price by construction, which
// is not a judgement on the lead.
export function scorePlace(
  facts: ScoringFacts,
  context: ScoringContext = { outcomeCount: 0 },
): PlaceScore {
  const price = estimatePrice(facts, context.grid ?? DEFAULT_PRICE_GRID);
  const success = estimateSuccess(facts, context);
  return {
    price,
    success,
    expectancyCents: Math.round(
      Math.min(1, success.rawProbability) * price.value12MonthsCents,
    ),
  };
}

// visible labels. `PriceOffer` keys stay ASCII and are never translated.
export const PRICE_OFFER_LABELS: Record<PriceOffer, string> = {
  base: "Base tier",
  "full-site": "Full site",
  "multi-page": "Multi-page site",
  "multi-address": "Multi-address site",
  "to-qualify": "To qualify",
  "by-quote": "By quote",
};

export function explainPrice(price: PriceEstimate): string {
  if (price.kind === "off-grid") {
    return `Off-grid — ${price.reason}`;
  }
  const parts = [
    `${PRICE_OFFER_LABELS[price.offer]} at ${formatEuros(price.priceCents, { decimals: "never" })}`,
    `${formatEuros(price.recurringCents, { decimals: "never" })}/month`,
  ];
  const adjustments = price.adjustments
    .map(
      (item) =>
        `${item.amountCents >= 0 ? "+" : "−"}${formatEuros(Math.abs(item.amountCents), { decimals: "never" })} ${item.label.toLowerCase()}`,
    )
    .join(", ");
  const tail = adjustments ? ` (${adjustments})` : "";
  return `${parts.join(", then ")}${tail}. ${price.reason}`;
}

export function explainSuccess(success: SuccessEstimate): string {
  if (success.probability === 0) {
    const killer = success.factors.find((factor) => factor.value === 0);
    return killer ? `${killer.label} — nothing to be done.` : "Deal disqualified.";
  }

  // furthest from 1 first: those are the ones that made the number.
  const telling = success.factors
    .filter((factor) => factor.label !== "Base rate" && factor.value !== 1)
    .sort((a, b) => Math.abs(Math.log(b.value)) - Math.abs(Math.log(a.value)))
    .slice(0, 3)
    .map((factor) => factor.label.toLowerCase());

  const because = telling.length > 0 ? `: ${telling.join(", ")}` : "";
  const caveat = success.calibrated
    ? ""
    : ` Estimate not calibrated (n = ${success.n}).`;
  return `${formatPercent(success.percent / 100)} odds${because}.${caveat}`;
}

// an off-grid price never quotes its expectancy: it is zero by construction.
export function explainPlaceScore(score: PlaceScore): string {
  const price = explainPrice(score.price);
  const success = explainSuccess(score.success);
  if (score.price.kind === "off-grid") {
    return `${price} ${success}`;
  }
  const value = formatEuros(score.price.value12MonthsCents, { decimals: "never" });
  const expectancy = formatEuros(score.expectancyCents, { decimals: "never" });
  return `${price} That is ${value} over twelve months. ${success} Expected value: ${expectancy}.`;
}

// a one-line reason for the loot figure, short enough for a list row or a map
// card. An off-grid target is not a zero-euro one: its expectancy is zero by
// construction, so the establishment count stands in for it instead.
// Returns a key + params, never English text: this module cannot call
// next-intl (see ARCHITECTURE.md), so the caller — always in real request
// context — translates it before it reaches the wire.
export function lootReason(
  score: PlaceScore,
  establishmentCount: number | null = null,
): LootReason {
  if (score.price.kind === "off-grid") {
    if (establishmentCount !== null && establishmentCount >= 2) {
      return { key: "lootReasonOffGridMulti", params: { count: establishmentCount } };
    }
    return { key: "lootReasonOffGridSingle", params: {} };
  }

  const expectancy = formatEuros(score.expectancyCents, { decimals: "never" });
  const value = formatEuros(score.price.value12MonthsCents, { decimals: "never" });
  return {
    key: "lootReasonExpected",
    params: { expectancy, percent: score.success.percent, value },
  };
}
