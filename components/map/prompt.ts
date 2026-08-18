// The target sheet exported as Markdown, to paste into an agent.
//
// Pure module: no database, no network, no implicit `Date`.
//
// What leaves here leaves the product, so the data rules still apply: no
// personal contact for a director (name and role only); no expired Google
// facts (`TargetRow` already nulls them past 30 days, and this module never
// reconstitutes them); and the resistance always ships with its calibration
// state, so a reader does not take an uncalibrated figure for a measurement.

import { createTranslator } from "next-intl";

import type { TargetDetail } from "@/app/queries";
import { SOURCE_ORDER, SOURCES } from "@/components/ui";
import { formatEuros, formatRatingTenths } from "@/lib/format";
import { PRICE_OFFER_LABELS } from "@/lib/scoring";
import { CALIBRATION_MIN_OUTCOMES } from "@/lib/types";

import { chosenSite, chosenPhone } from "./fields";
import { fiveFacts } from "./facts";
import {
  distance,
  dateFromDay,
  longDate,
  formatNumber,
} from "./text";
import type { EventKind, TargetState } from "@/lib/types";

import enMessages from "../../messages/en.json";

// This export leaves the product for an agent to read, so it stays in a
// single fixed language regardless of the UI locale — deliberately NOT
// wired to next-intl for its OWN strings below (see `text.ts` for the
// UI-facing, locale-aware versions of these same labels). It still calls into
// `fiveFacts`, which IS wired to next-intl for the UI's sake, so this builds
// a translator locked to English rather than letting the request's locale
// leak into an export that must read the same everywhere.
// Cast rather than relying on generic inference to line up with `facts.ts`'s
// own `T` (derived from `useTranslations`, not `createTranslator`): both are
// the same next-intl translator shape at runtime, but inferred through two
// different generic paths that don't unify structurally.
const factsTranslator = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "Facts",
}) as Parameters<typeof fiveFacts>[2];
const STATE_LABEL: Record<TargetState, string> = {
  spotted: "Spotted",
  studied: "Studied",
  engaged: "Engaged",
  taken: "Taken",
  withdrawn: "Withdrawn",
  dismissed: "Set aside",
};

const EVENT_LABEL: Record<EventKind, string> = {
  survey: "Spotted",
  study: "Study",
  contact: "Call",
  reply: "Reply",
  take: "Taken",
  withdrawal: "Withdrawn",
};

const PROXIMITY_LABEL: Record<string, string> = {
  "same-street-capture": "Same street as a deal we took",
  "near-live-deal": "Within 300 m of a live deal",
  "in-zone": "No reference nearby",
  "outside-zone": "Outside the worked sectors",
};

/**
 * A Markdown table cell, escaped.
 *
 * A `|` in a business name ("BAR | TABAC" exists) would split the cell and
 * shift the row; a newline from a log note would end the table.
 */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A missing value is written out, never silently dropped. */
function orElse(value: string | null | undefined, fallbackValue = "unknown"): string {
  if (value === null || value === undefined) return fallbackValue;
  const cleaned = value.trim();
  return cleaned === "" ? fallbackValue : cleaned;
}

/**
 * The address on one line, without repeating what it already contains.
 *
 * SIRENE's `address` already carries the postcode and town
 * ("12 RUE DES EXEMPLES 75009 PARIS"), so concatenating the three columns
 * would yield "... 75009 PARIS 75009 PARIS".
 */
function addressOf(target: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
}): string {
  const base = (target.address ?? "").trim();
  const parts: string[] = base === "" ? [] : [base];
  const upper = base.toUpperCase();

  for (const part of [target.postalCode, target.city]) {
    const cleaned = (part ?? "").trim();
    if (cleaned === "" || upper.includes(cleaned.toUpperCase())) continue;
    parts.push(cleaned);
  }

  return parts.length === 0 ? "unknown" : parts.join(" ");
}

/** `"NN"` is the INSEE code for "headcount not filed", not a band. */
function readableBand(raw: string | null): string | null {
  const cleaned = (raw ?? "").trim();
  if (cleaned === "" || cleaned === "NN") return null;
  return cleaned;
}

/**
 * The full brief for a business, in Markdown.
 *
 * The order follows the sheet, therefore the work: what it is, what it is
 * worth, what to act on, where the figure comes from, what has been said.
 */
export function sheetAsMarkdown(
  detail: TargetDetail,
  outcomeCount: number,
  now: Date = new Date(),
): string {
  const { target, log, neighbours } = detail;
  const price = target.score.price;
  const success = target.score.success;
  const offGrid = price.kind === "off-grid";
  const calibrated = outcomeCount >= CALIBRATION_MIN_OUTCOMES;
  const facts = fiveFacts(target, now, factsTranslator);

  const rows: string[] = [];

  rows.push(`# ${target.name}`);
  rows.push("");
  rows.push(
    "Prospecting brief exported from Towncenter. Every figure below is either a " +
      "fact recorded from a named source, or a calculation whose breakdown is " +
      "given. Nothing is estimated without saying so.",
  );
  rows.push("");

  rows.push("## Identity");
  rows.push("");
  rows.push(`- **Business**: ${target.name}`);
  if (target.legalName && target.legalName !== target.name) {
    rows.push(`- **Legal name**: ${target.legalName}`);
  }
  rows.push(`- **Address**: ${addressOf(target)}`);
  rows.push(`- **SIREN / SIRET**: ${target.siren} / ${target.siret}`);
  rows.push(`- **Activity**: ${orElse(target.naf, "NAF unknown")} — ${orElse(target.nafLabel)}`);
  if (target.companyCreatedAt) {
    rows.push(
      `- **Founded**: ${orElse(dateFromDay(target.companyCreatedAt), target.companyCreatedAt)}`,
    );
  }
  if (target.establishmentCount !== null) {
    rows.push(`- **Open establishments**: ${target.establishmentCount}`);
  }
  const band = readableBand(target.employeeRange);
  if (band) {
    rows.push(`- **INSEE headcount band**: ${band}`);
  }
  if (target.revenueCents !== null && target.financesYear !== null) {
    rows.push(
      `- **Revenue ${target.financesYear}**: ${formatEuros(target.revenueCents, { decimals: "never" })}`,
    );
  }
  // The CHOSEN address and number, not Google's: a hand-typed value wins, and
  // the brief must carry what the sheet shows.
  const site = chosenSite(target);
  const tel = chosenPhone(target);
  if (site) {
    rows.push(
      `- **Website**: ${site.url}${site.source === "log" ? " (recorded by hand)" : ""}`,
    );
  }
  if (tel) {
    rows.push(
      `- **Establishment phone**: ${tel.number}${tel.source === "log" ? " (recorded by hand)" : ""}`,
    );
  }
  if (target.ratingTenths !== null) {
    rows.push(
      `- **Google**: ${formatRatingTenths(target.ratingTenths)}/5 from ${orElse(
        target.reviewCount === null ? null : `${target.reviewCount} reviews`,
        "an unknown number of reviews",
      )}`,
    );
  } else if (target.googleStale) {
    rows.push(
      "- **Google**: the facts passed 30 days and were purged " +
        "(terms of service). Refresh before using them.",
    );
  }

  // Directors: name and ROLE, never a contact. The product stores nothing else.
  if (target.directors.length > 0) {
    const names = target.directors
      .map((person) =>
        `${[person.firstNames, person.lastName].filter(Boolean).join(" ")} (${person.title})`.trim(),
      )
      .join(", ");
    rows.push(`- **Directors**: ${names}`);
  }
  rows.push(`- **Neighbourhood**: ${PROXIMITY_LABEL[target.proximity] ?? target.proximity}`);
  rows.push("");

  rows.push("## What it is worth, and what stands in the way");
  rows.push("");

  if (offGrid) {
    rows.push(
      `- **Spoils**: off-grid. ${price.reason} This is not a zero-euro target: ` +
        "it is one where the work goes beyond the default offer, to be priced by " +
        "hand after a visit.",
    );
  } else {
    rows.push(
      `- **Spoils over 12 months**: ${formatEuros(price.value12MonthsCents, { decimals: "never" })}`,
    );
    rows.push(
      `- **Offer**: ${PRICE_OFFER_LABELS[price.offer]} at ${formatEuros(price.priceCents, { decimals: "never" })} on signature` +
        (price.recurringCents > 0
          ? `, then ${formatEuros(price.recurringCents, { decimals: "never" })} per month`
          : ""),
    );
    for (const adjustment of price.adjustments) {
      rows.push(
        `  - ${adjustment.label}: ${adjustment.amountCents >= 0 ? "+" : "−"} ${formatEuros(Math.abs(adjustment.amountCents), { decimals: "never" })}`,
      );
    }
  }

  rows.push(
    `- **Resistance**: ${target.resistancePercent} %` +
      (calibrated
        ? ""
        : ` — **not calibrated yet, n = ${outcomeCount}** (${CALIBRATION_MIN_OUTCOMES} real outcomes are needed; below that it is an opinion, not a measurement)`),
  );
  rows.push(`- **Approach state**: ${STATE_LABEL[target.state]}`);
  rows.push("");

  rows.push("## The five facts");
  rows.push("");
  rows.push("| Fact | Value | Source | Recorded on |");
  rows.push("| --- | --- | --- | --- |");
  for (const fact of facts) {
    const value =
      fact.verbatim.length > 0 ? fact.verbatim.join(" · ") : "not recorded";
    // Full source names, not the ASCII keys: "sirene" leads nowhere for a
    // reader who wants to go back and check.
    const provenance = fact.sources.map((key) => SOURCES[key].name).join(" · ");
    rows.push(
      `| ${cell(fact.name)} | ${cell(value)}${fact.stale ? " (expired)" : ""} | ${cell(orElse(provenance, "—"))} | ${cell(orElse(fact.surveyedOn, "—"))} |`,
    );
  }
  rows.push("");
  rows.push(
    "A statistic with no data is **not a zero**: it is excluded from the calculation, " +
      "and the resistance above was built on the available facts only.",
  );
  rows.push("");

  // Only the sources actually cited by the five facts: listing all five on a
  // business that was never enriched would suggest Google answered something.
  const provenances = SOURCE_ORDER.filter((key) =>
    facts.some((fact) => fact.sources.includes(key)),
  );

  if (provenances.length > 0) {
    rows.push("## Where each fact comes from");
    rows.push("");
    for (const key of provenances) {
      const source = SOURCES[key];
      rows.push(
        `- **${source.name}**${source.href ? ` (${source.href})` : ""} — ${source.what}`,
      );
    }
    rows.push("");
    rows.push(
      "Everything below this line is **computed**, not recorded: the spoils come from " +
        "the price grid, the resistance from the product of the factors. Neither is a " +
        "measurement, and both are broken down so they can be checked by hand.",
    );
    rows.push("");
  }

  rows.push("## Where the resistance comes from");
  rows.push("");
  rows.push("| Factor | Value |");
  rows.push("| --- | --- |");
  success.factors.forEach((factor, index) => {
    rows.push(
      `| ${cell(factor.label)} | ${index === 0 ? formatNumber(factor.value, 3) : `× ${formatNumber(factor.value, 2)}`} |`,
    );
  });
  rows.push(
    `| **Raw product** | ${formatNumber(success.rawProbability, 4)} odds |`,
  );
  rows.push(
    `| **Clamped then rounded to the nearest 5** | ${success.percent} % odds |`,
  );
  rows.push(
    `| **Resistance = 100 − ${success.percent}** | ${target.resistancePercent} % |`,
  );
  rows.push("");
  rows.push(
    "The product is clamped between 2 % and 85 % odds before rounding: an estimate " +
      "built on a handful of facts does not have three significant digits.",
  );
  rows.push("");

  rows.push("## The neighbours, within 300 m");
  rows.push("");
  if (neighbours.length === 0) {
    rows.push(
      "No surveyed business within walking distance. That is missing information, " +
        "not an empty neighbourhood.",
    );
  } else {
    rows.push(
      "The sector’s commercial lever: “I rebuilt the site of the florist across the " +
        "street” is not the same call.",
    );
    rows.push("");
    for (const neighbour of neighbours) {
      rows.push(
        `- ${neighbour.name} — ${distance(neighbour.distanceMeters)} · ${formatEuros(neighbour.expectancyCents, { decimals: "never" })} · ${STATE_LABEL[neighbour.state]}`,
      );
    }
  }
  rows.push("");

  rows.push("## The log");
  rows.push("");
  if (log.length === 0) {
    rows.push("Nothing has been said about this business yet.");
  } else {
    for (const entry of log) {
      const amount =
        entry.valueCents !== null
          ? ` · ${formatEuros(entry.valueCents, { decimals: "never" })}`
          : "";
      const note = entry.note ? ` — ${entry.note.replace(/\r?\n/g, " ")}` : "";
      rows.push(
        `- **${orElse(longDate(entry.occurredAt), "date unknown")}** · ${EVENT_LABEL[entry.kind]}${amount}${note}`,
      );
    }
  }
  rows.push("");

  rows.push("## The request");
  rows.push("");
  rows.push(
    offGrid
      ? "This deal is off-grid: the price cannot be derived from the price list. " +
          "Help me prepare the approach and price a quote by hand from the facts " +
          "above."
      : "Help me prepare the approach to this business from the facts above: the way " +
          "in, what to check before calling, and which of the factors can be improved " +
          "by real work rather than by an argument.",
  );
  rows.push("");
  rows.push(
    "Do not invent any figure that is not above. If a fact is missing, say that it " +
      "is missing.",
  );

  return rows.join("\n");
}
