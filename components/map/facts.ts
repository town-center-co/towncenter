// The five facts of a target: Storefront, Footfall, Footing, Means, Access.
// Each is 0-100, derived from recorded data, and carries its source. They
// EXPLAIN the resistance, they never recompute it: the displayed resistance
// comes from `scorePlace()` and nowhere else.
//
// Pure module: no network, no database, no DOM. `TargetRow` is imported as a
// type only, so it is erased at compile time — `app/queries.ts` is
// `server-only` and must never reach the browser bundle.

import type { useTranslations } from "next-intl";

import type { TargetRow } from "@/app/queries";
import type { SourceKey } from "@/components/ui";
import { formatEuros, formatRatingTenths } from "@/lib/format";
import {
  REVENUE_GOOD_CENTS,
  REVENUE_COMFORTABLE_CENTS,
  REVENUE_LOW_CENTS,
  HEADCOUNT_GOOD,
  HEADCOUNT_HIGH,
  FINANCES_MAX_AGE_YEARS,
  REVIEWS_PER_YEAR_GOOD,
  REVIEWS_PER_YEAR_HIGH,
  REVIEWS_PER_YEAR_AVERAGE,
  SITE_STALE_MONTHS,
} from "@/lib/scoring";

import { yearsSince, shortDate, dateFromDay, longDate, formatNumber } from "./text";

// prompt.ts (outside React, always English — see its own header comment)
// builds one of these with `createTranslator` rather than a hook; structurally
// compatible with `useTranslations`/`getTranslations` either way.
type T = ReturnType<typeof useTranslations<"Facts">>;

export type FactKey = "storefront" | "footfall" | "footing" | "means" | "access";

export type TargetFact = {
  /** ASCII key: drives a React `key` and a `data-fact` attribute. */
  key: FactKey;
  /** Visible label. */
  name: string;
  /** 0 to 100, or `null` when the data is missing. A missing fact is never a zero. */
  value: number | null;
  /** The raw facts, verbatim. Never reworded. */
  verbatim: string[];
  /** One key per provider actually queried; an array because a fact can cross two. */
  sources: readonly SourceKey[];
  /** "14/07". Null when the data carries no clean timestamp. */
  surveyedOn: string | null;
  /** True once the Google facts passed 30 days. */
  stale: boolean;
  /**
   * Why the statistic is empty, or what the figure does not say.
   *
   * `Fact` hides the verbatim when the value is null, so the note is rendered
   * beside it by the sheet. "Site unreachable" is an observation, not an
   * absence of data, and the two must not read the same.
   */
  note: string | null;
};

type Mark = { ok: boolean; text: string };

function percentOfMarks(marks: readonly Mark[]): number | null {
  if (marks.length === 0) return null;
  const met = marks.filter((mark) => mark.ok).length;
  return Math.round((met / marks.length) * 100);
}

/** Average of the KNOWN parts. `null` if none is known. */
function average(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
}

/**
 * Lower bound of the headcount from the INSEE band code.
 *
 * Same table as `employeeFloor` in `lib/scoring.ts`, which does not export it.
 * `NN` and any unknown code return `null`: a headcount is never guessed.
 */
const HEADCOUNT_FLOOR: Record<string, number> = {
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

function headcountFloor(code: string | null): number | null {
  if (!code) return null;
  return HEADCOUNT_FLOOR[code.trim()] ?? null;
}

/** 1. Storefront — the state of the website, from the in-house audit. */
function storefront(target: TargetRow, now: Date, t: T): TargetFact {
  const base = {
    key: "storefront" as const,
    name: t("nameStorefront"),
    sources: ["audit"] as const,
    surveyedOn: shortDate(target.auditedAt),
    stale: false,
  };

  const audit = target.siteAudit;

  if (!audit) {
    return {
      ...base,
      surveyedOn: null,
      value: null,
      verbatim: [],
      // "Never audited" is not "no website": the first leaves the scoring
      // factor neutral, the second raises it.
      note: t("neverAudited"),
    };
  }

  if (audit.instagramAsSite) {
    return {
      ...base,
      value: 5,
      verbatim: [t("instagramAsWebsite"), audit.url ?? ""].filter(Boolean),
      note: null,
    };
  }

  if (audit.issue === "no_known_site") {
    // The source follows the fact: "no website" was not read by the audit,
    // which had nothing to read. Google is what knows the place.
    return {
      ...base,
      sources: ["google"] as const,
      value: 0,
      verbatim: [t("noKnownWebsite")],
      note: null,
    };
  }

  if (audit.issue === "site_unreachable") {
    return {
      ...base,
      value: null,
      verbatim: [],
      note: audit.url
        ? t("siteUnreachableWithUrl", { url: audit.url })
        : t("siteUnreachable"),
    };
  }

  const marks: Mark[] = [];

  if (audit.https !== undefined) {
    marks.push({ ok: audit.https, text: audit.https ? t("https") : t("noHttps") });
  }
  if (audit.viewport !== undefined) {
    marks.push({
      ok: audit.viewport,
      text: audit.viewport ? t("mobileReady") : t("noMobileViewport"),
    });
  }
  if (audit.titleFilled !== undefined) {
    marks.push({
      ok: audit.titleFilled,
      text: audit.titleFilled ? t("titleFilledIn") : t("titleEmptyOrGeneric"),
    });
  }
  if (audit.structuredData !== undefined) {
    marks.push({
      ok: audit.structuredData,
      text: audit.structuredData ? t("hasStructuredData") : t("noStructuredData"),
    });
  }
  if (audit.defaultTheme !== undefined) {
    marks.push({
      ok: !audit.defaultTheme,
      text: audit.defaultTheme ? t("defaultThemeNeverTouched") : t("customTheme"),
    });
  }
  if (audit.sitemapUrlCount !== undefined) {
    marks.push({
      ok: audit.sitemapUrlCount >= 1,
      text:
        audit.sitemapUrlCount >= 1
          ? t("sitemapUrlCount", { count: formatNumber(audit.sitemapUrlCount, 0) })
          : t("noSitemap"),
    });
  }
  if (audit.usablePhotos !== undefined) {
    marks.push({
      ok: audit.usablePhotos,
      text: audit.usablePhotos ? t("usablePhotos") : t("noUsablePhoto"),
    });
  }
  if (audit.agencyDetected !== undefined) {
    // An agency already in place is a quality mark for the storefront, even
    // though it is bad news for the deal.
    marks.push({
      ok: audit.agencyDetected,
      text: audit.agencyDetected ? t("agencyAlreadyInPlace") : t("noAgencyCredited"),
    });
  }

  if (audit.lastModified) {
    const years = yearsSince(audit.lastModified.slice(0, 10), now);
    const months = years === null ? null : Math.round(years * 12);
    if (months !== null) {
      marks.push({
        ok: months <= SITE_STALE_MONTHS,
        text:
          months <= SITE_STALE_MONTHS
            ? t("signOfLife", { date: longDate(audit.lastModified) ?? "" })
            : t("noChangeTrace", { months }),
      });
    }
  }

  const verbatim = [audit.tech, ...marks.map((mark) => mark.text)].filter(
    (text): text is string => Boolean(text),
  );

  // These two decide the SCOPE of the deal, not the storefront score. They are
  // reported, never counted.
  if (audit.onlineSales) verbatim.push(t("onlineSales"));
  if (audit.onlineBooking) verbatim.push(t("onlineBooking"));

  return {
    ...base,
    value: percentOfMarks(marks),
    verbatim,
    note: marks.length === 0 ? t("noMarkerFound") : null,
  };
}

/** 2. Footfall — Google rating and reviews, expired at 30 days. */
function footfall(target: TargetRow, now: Date, t: T): TargetFact {
  const base = {
    key: "footfall" as const,
    name: t("nameFootfall"),
    sources: ["google"] as const,
    surveyedOn: shortDate(target.googleFetchedAt),
    stale: target.googleStale,
  };

  if (target.googleStale) {
    return {
      ...base,
      value: null,
      verbatim: [],
      // Google's terms require ERASING these past 30 days, not just hiding
      // them. The enrichment purges, this screen says so.
      note: t("googlePurged"),
    };
  }

  if (target.ratingTenths === null && target.reviewCount === null) {
    return {
      ...base,
      surveyedOn: null,
      value: null,
      verbatim: [],
      note: target.googleFetchedAt ? t("noRatingNoReviews") : t("neverQueried"),
    };
  }

  const rating = target.ratingTenths;
  const reviews = target.reviewCount ?? 0;

  // Rating on its native scale, in tenths: 5.0 is 100.
  const ratingScore = rating === null ? null : Math.round((rating / 50) * 100);

  // Footfall is judged on the PACE, not the total. Same thresholds as
  // `capacityFactor` in the scoring, so both readings agree.
  const years = yearsSince(target.companyCreatedAt, now);
  const perYear = years !== null && years >= 1 ? reviews / years : reviews;

  let paceScore: number;
  if (perYear >= REVIEWS_PER_YEAR_HIGH) paceScore = 100;
  else if (perYear >= REVIEWS_PER_YEAR_GOOD) paceScore = 75;
  else if (perYear >= REVIEWS_PER_YEAR_AVERAGE) paceScore = 50;
  else paceScore = 25;

  const verbatim: string[] = [];
  if (rating !== null) verbatim.push(t("ratingValue", { rating: formatRatingTenths(rating) }));
  verbatim.push(t("reviewCount", { count: formatNumber(reviews, 0) }));
  if (years !== null && years >= 1) {
    verbatim.push(t("reviewsPerYear", { count: formatNumber(Math.round(perYear), 0) }));
  }
  if (target.priceLevel !== null) {
    verbatim.push(t("priceLevelValue", { level: "€".repeat(Math.max(1, target.priceLevel)) }));
  }
  if (target.businessStatus === "CLOSED_PERMANENTLY") {
    verbatim.push(t("closedPermanently"));
  }

  return {
    ...base,
    value: average([ratingScore, paceScore]),
    verbatim,
    note: null,
  };
}

/** 3. Footing — age and number of open establishments. */

/** Twenty years of trading fills the bar. */
const FOOTING_FULL_YEARS = 20;

function footing(target: TargetRow, now: Date, t: T): TargetFact {
  const base = {
    key: "footing" as const,
    name: t("nameFooting"),
    sources: ["sirene"] as const,
    surveyedOn: null,
    stale: false,
  };

  const years = yearsSince(target.companyCreatedAt, now);
  const ageScore =
    years === null ? null : Math.round(Math.min(1, years / FOOTING_FULL_YEARS) * 100);

  const establishments = target.establishmentCount;
  let establishmentScore: number | null = null;
  if (establishments !== null && establishments >= 1) {
    if (establishments >= 5) establishmentScore = 100;
    else if (establishments >= 2) establishmentScore = 60;
    else establishmentScore = 30;
  }

  const verbatim: string[] = [];
  const founded = dateFromDay(target.companyCreatedAt);
  if (founded && years !== null) {
    verbatim.push(t("founded", { date: founded }), t("yearsInBusiness", { count: Math.floor(years) }));
  }
  if (establishments !== null) {
    verbatim.push(t("openEstablishmentCount", { count: establishments }));
  }
  if (target.companyCategory) verbatim.push(target.companyCategory);

  const value = average([ageScore, establishmentScore]);

  return {
    ...base,
    value,
    verbatim,
    note: value === null ? t("noFootingData") : null,
  };
}

/** 4. Means — revenue, headcount, company category. */
function means(target: TargetRow, now: Date, t: T): TargetFact {
  const base = {
    key: "means" as const,
    name: t("nameMeans"),
    sources: ["sirene"] as const,
    surveyedOn: null,
    stale: false,
  };

  const verbatim: string[] = [];
  const notes: string[] = [];

  let revenueScore: number | null = null;
  const financialYear = target.financesYear;
  const currentYear = now.getUTCFullYear();
  const recentFinancialYear =
    financialYear === null || currentYear - financialYear <= FINANCES_MAX_AGE_YEARS;

  // `revenueCents: null` is not zero: SIRENE reports `ca: 0` for "accounts not
  // filed". A null value is an absence, not poverty.
  if (target.revenueCents !== null && target.revenueCents > 0) {
    verbatim.push(
      financialYear
        ? t("revenueWithYear", {
            amount: formatEuros(target.revenueCents, { decimals: "never" }),
            year: financialYear,
          })
        : t("revenue", {
            amount: formatEuros(target.revenueCents, { decimals: "never" }),
          }),
    );
    if (recentFinancialYear) {
      if (target.revenueCents >= REVENUE_COMFORTABLE_CENTS) revenueScore = 100;
      else if (target.revenueCents >= REVENUE_GOOD_CENTS) revenueScore = 75;
      else if (target.revenueCents >= REVENUE_LOW_CENTS) revenueScore = 50;
      else revenueScore = 25;
    } else {
      // A financial year older than the cutoff does not penalise; it falls
      // through to headcount, exactly as `capacityFactor` does.
      notes.push(t("financialYearTooOld", { year: financialYear }));
    }
  }

  if (target.netIncomeCents !== null) {
    verbatim.push(
      t("netIncome", { amount: formatEuros(target.netIncomeCents, { decimals: "never" }) }),
    );
  }

  const headcount = headcountFloor(target.employeeRange);
  let headcountScore: number | null = null;
  if (headcount !== null) {
    if (headcount >= HEADCOUNT_HIGH) headcountScore = 100;
    else if (headcount >= HEADCOUNT_GOOD) headcountScore = 70;
    else if (headcount >= 1) headcountScore = 40;
    else headcountScore = 15;
    verbatim.push(
      headcount === 0 ? t("noEmployees") : t("employeesOrMore", { count: headcount }),
    );
  }

  const value = average([revenueScore, headcountScore]);

  return {
    ...base,
    value,
    verbatim,
    note: value === null ? (notes[0] ?? t("nothingToMeasure")) : (notes[0] ?? null),
  };
}

/** 5. Access — who there is to talk to. */
function access(target: TargetRow, t: T): TargetFact {
  const base = {
    key: "access" as const,
    name: t("nameAccess"),
    // The source badge follows WHO SUPPLIED the value: a hand-typed number
    // comes from your log, not from Google Places.
    sources: (target.manualPhone
      ? ["sirene", "log"]
      : ["sirene", "google"]) as readonly SourceKey[],
    surveyedOn: null,
    stale: false,
  };

  const verbatim: string[] = [];
  const parts: (number | null)[] = [];

  // Directors are always known: SIRENE returns an array, and an empty array is
  // an observation. Statutory auditors were already dropped at harvest time.
  const director = target.directors[0];
  parts.push(target.directors.length > 0 ? 100 : 0);
  if (director) {
    const name = [director.firstNames, director.lastName].filter(Boolean).join(" ");
    verbatim.push(`${name} — ${director.title.toLowerCase()}`);
    if (target.directors.length > 1) {
      verbatim.push(t("andOthers", { count: target.directors.length - 1 }));
    }
  } else {
    verbatim.push(t("noDirectorNamed"));
  }

  // A hand-typed phone number wins and never goes stale: it is not Google
  // data, so the 30-day rule does not apply to it.
  if (target.manualPhone) {
    parts.push(100);
    verbatim.push(target.manualPhone);
  } else if (target.googleStale || !target.googleFetchedAt) {
    parts.push(null);
  } else {
    parts.push(target.phone ? 100 : 0);
    verbatim.push(target.phone ?? t("noKnownPhoneNumber"));
  }

  parts.push(target.address ? 100 : 0);
  if (target.address) {
    verbatim.push([target.address, target.postalCode, target.city].filter(Boolean).join(" · "));
  }

  return {
    ...base,
    value: average(parts),
    verbatim,
    note:
      target.manualPhone || !(target.googleStale || !target.googleFetchedAt)
        ? null
        : t("phoneNotCounted"),
  };
}

/**
 * The five statistics of a business, in display order.
 *
 * The order is usefulness on a phone call, not alphabetical: storefront (the
 * reason to call), footfall, footing, means, then access.
 */
export function fiveFacts(target: TargetRow, now: Date = new Date(), t: T): TargetFact[] {
  return [
    storefront(target, now, t),
    footfall(target, now, t),
    footing(target, now, t),
    means(target, now, t),
    access(target, t),
  ];
}

/** How many of the five actually carry data. The denominator of the arc. */
export function recordedFacts(facts: readonly TargetFact[]): number {
  return facts.filter((fact) => fact.value !== null).length;
}
