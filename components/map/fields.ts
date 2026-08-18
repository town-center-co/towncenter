// Every field of a target sheet, including the empty ones. An empty field
// carries the action that would fill it, or a written reason why nothing can.
// Pure module: no network, no database, no DOM.

import type { TargetRow } from "@/app/queries";
import type { SourceKey } from "@/components/ui";
import { formatEuros, formatRatingTenths } from "@/lib/format";

import type { useTranslations } from "next-intl";

import {
  stateLabel,
  proximityLabel,
  shortDate,
  dateFromDay,
  formatNumber,
} from "./text";

// See the note in `text.ts`: structurally compatible with both
// `useTranslations` and `getTranslations`.
type T = ReturnType<typeof useTranslations<"TargetLabels">>;

/** The action that would fill a field. `kind` values are ASCII keys. */
export type FieldAction =
  | { kind: "api"; prompt: string }
  /** `field` is the key passed to `noteTargetFieldAction`, not a label. */
  | { kind: "input"; field: "website" | "phone"; prompt: string }
  | { kind: "resurvey"; prompt: string }
  /** Nothing can fill it, and the reason is spelled out. */
  | { kind: "none"; reason: string };

export type TargetField = {
  /** ASCII key: React `key` and `data-field`. Never translated. */
  key: string;
  /** Visible label. */
  name: string;
  /** Already formatted. `null` means empty, and then `action` carries the sheet. */
  value: string | null;
  sources: readonly SourceKey[];
  /** Always present when `value` is null. */
  action: FieldAction | null;
  /** Shown above the "See all fields" fold. */
  primary: boolean;
};

export type FieldGroup = {
  /** ASCII key. */
  key: "registry" | "google" | "audit" | "log";
  /** Visible label. */
  name: string;
  fields: TargetField[];
};

const PROMPT_GOOGLE = "Fetch the facts";
const PROMPT_SURVEY = "Re-survey the sector";

function nothingToSay(reason: string): FieldAction {
  return { kind: "none", reason };
}

function field(
  key: string,
  name: string,
  value: string | null,
  sources: readonly SourceKey[],
  action: FieldAction,
  primary = false,
): TargetField {
  return { key, name, value, sources, action: value === null ? action : null, primary };
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The website address actually used, and who supplied it.
 *
 * A hand-typed value wins over Google: if you typed one, Google was silent or
 * wrong. `enrichOne()` applies the same rule and the two must agree, otherwise
 * the sheet shows an address the audit will never read.
 */
export function chosenSite(
  target: TargetRow,
): { url: string; source: SourceKey } | null {
  const manual = text(target.manualWebsiteUrl);
  if (manual) return { url: manual, source: "log" };
  const google = text(target.websiteUrl);
  if (google) return { url: google, source: "google" };
  return null;
}

/** Same rule for the phone number. */
export function chosenPhone(
  target: TargetRow,
): { number: string; source: SourceKey } | null {
  const manual = text(target.manualPhone);
  if (manual) return { number: manual, source: "log" };
  const google = text(target.phone);
  if (google) return { number: google, source: "google" };
  return null;
}

function registryGroup(target: TargetRow): FieldGroup {
  const years = dateFromDay(target.companyCreatedAt);

  return {
    key: "registry",
    name: "The registry",
    fields: [
      field("siret", "SIRET", target.siret, ["sirene"], nothingToSay("Always present.")),
      field("siren", "SIREN", target.siren, ["sirene"], nothingToSay("Always present.")),
      field(
        "legalName",
        "Legal name",
        text(target.legalName),
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
      field(
        "naf",
        "Activity",
        [text(target.naf), text(target.nafLabel)].filter(Boolean).join(" · ") || null,
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
      field(
        "address",
        "Address",
        [target.address, target.postalCode, target.city].filter(Boolean).join(" · ") || null,
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
      field(
        "founded",
        "Founded",
        years,
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
      field(
        "establishments",
        "Open establishments",
        target.establishmentCount === null ? null : formatNumber(target.establishmentCount, 0),
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
      field(
        "headcount",
        "Headcount band",
        // `NN` is the INSEE code for "not filed", not a band.
        text(target.employeeRange) === "NN" ? null : text(target.employeeRange),
        ["sirene"],
        nothingToSay("The registry filed no headcount band for this establishment."),
      ),
      field(
        "category",
        "Company category",
        text(target.companyCategory),
        ["sirene"],
        nothingToSay("Not classified by the registry."),
      ),
      field(
        "revenue",
        "Revenue",
        target.revenueCents === null
          ? null
          : `${formatEuros(target.revenueCents, { decimals: "never" })}${target.financesYear ? ` (${target.financesYear})` : ""}`,
        ["sirene"],
        // SIRENE returns `ca: 0` for "accounts not filed". That is an answer,
        // not a gap, so there is no button to offer.
        nothingToSay("No accounts filed. That is an answer from the registry, not a gap."),
        true,
      ),
      field(
        "netIncome",
        "Net income",
        target.netIncomeCents === null
          ? null
          : formatEuros(target.netIncomeCents, { decimals: "never" }),
        ["sirene"],
        nothingToSay("No accounts filed."),
      ),
      field(
        "directors",
        "Directors",
        target.directors.length === 0
          ? null
          : target.directors
              .map((person) =>
                `${[person.firstNames, person.lastName].filter(Boolean).join(" ")} — ${person.title.toLowerCase()}`.trim(),
              )
              .join(" · "),
        ["sirene"],
        { kind: "resurvey", prompt: PROMPT_SURVEY },
      ),
    ],
  };
}

function googleGroup(target: TargetRow): FieldGroup {
  const site = chosenSite(target);
  const tel = chosenPhone(target);

  // Google facts are purged past 30 days under Google's terms, so an empty
  // field after a purge is not the same thing as one never queried.
  const prompt = target.googleStale
    ? "Purged past 30 days — fetch again"
    : PROMPT_GOOGLE;

  return {
    key: "google",
    name: "Google Places",
    fields: [
      {
        key: "website",
        name: "Website",
        value: site?.url ?? null,
        // The source badge follows WHO SUPPLIED the value, not the column.
        sources: site ? [site.source] : ["google", "log"],
        action: site
          ? null
          : { kind: "input", field: "website", prompt: "Set the website…" },
        primary: true,
      },
      {
        key: "phone",
        name: "Phone",
        value: tel?.number ?? null,
        sources: tel ? [tel.source] : ["google", "log"],
        action: tel
          ? null
          : { kind: "input", field: "phone", prompt: "Set the phone…" },
        primary: true,
      },
      field(
        "rating",
        "Rating",
        target.ratingTenths === null ? null : `${formatRatingTenths(target.ratingTenths)} / 5`,
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "reviews",
        "Reviews",
        target.reviewCount === null ? null : formatNumber(target.reviewCount, 0),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "priceLevel",
        "Price level",
        target.priceLevel === null ? null : "€".repeat(Math.max(1, target.priceLevel)),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "hours",
        "Opening hours",
        target.openingHours?.weekdayDescriptions?.length
          ? `${target.openingHours.weekdayDescriptions.length} days published`
          : null,
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "status",
        "Business status",
        text(target.businessStatus),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "lastQueried",
        "Last queried",
        shortDate(target.googleFetchedAt),
        ["google"],
        { kind: "api", prompt: PROMPT_GOOGLE },
      ),
    ],
  };
}

/**
 * The in-house site audit.
 *
 * While the audit has never run, the group is a single row: twelve empty
 * markers would read as a ruined record when nothing was ever asked. Without a
 * website address the audit has nothing to read, so the offered action is
 * manual entry rather than enrichment.
 */
function auditGroup(target: TargetRow): FieldGroup {
  const site = chosenSite(target);
  const audit = target.siteAudit;

  if (!audit) {
    return {
      key: "audit",
      name: "The site audit",
      fields: [
        {
          key: "audit",
          name: "Site audit",
          value: null,
          sources: ["audit"],
          action: site
            ? { kind: "api", prompt: PROMPT_GOOGLE }
            : {
                kind: "input",
                field: "website",
                prompt: "No address to read — set the website…",
              },
          primary: false,
        },
      ],
    };
  }

  /** One audit marker. `undefined` means the audit could not conclude. */
  const mark = (
    key: string,
    name: string,
    value: boolean | undefined,
    yes: string,
    no: string,
  ): TargetField => ({
    key,
    name,
    value: value === undefined ? null : value ? yes : no,
    sources: ["audit"],
    // `false` is an observation, a missing key is ignorance. Only the second
    // carries an action, and there is no good one: the page was read.
    action:
      value === undefined
        ? nothingToSay("The page was read; this marker was not found on it.")
        : null,
    primary: false,
  });

  return {
    key: "audit",
    name: "The site audit",
    fields: [
      field("url", "Audited address", text(audit.url), ["audit"], {
        kind: "input",
        field: "website",
        prompt: "Set the website…",
      }),
      field("auditedOn", "Audited on", shortDate(target.auditedAt), ["audit"], {
        kind: "api",
        prompt: PROMPT_GOOGLE,
      }),
      field("tech", "Technology", text(audit.tech), ["audit"], nothingToSay(
        "No recognised technology marker in the page.",
      )),
      mark("https", "HTTPS", audit.https, "Yes", "No"),
      mark("viewport", "Mobile viewport", audit.viewport, "Yes", "No"),
      mark("title", "Title", audit.titleFilled, "Filled in", "Empty or generic"),
      mark(
        "structuredData",
        "Structured data",
        audit.structuredData,
        "Present",
        "Absent",
      ),
      mark("theme", "Theme", audit.defaultTheme, "Default, untouched", "Custom"),
      mark("photos", "Usable photos", audit.usablePhotos, "Yes", "No"),
      mark("agency", "Agency credited", audit.agencyDetected, "Yes", "No"),
      mark("onlineSales", "Online sales", audit.onlineSales, "Yes", "No"),
      mark("onlineBooking", "Online booking", audit.onlineBooking, "Yes", "No"),
      field(
        "sitemap",
        "Sitemap",
        audit.sitemapUrlCount === undefined
          ? null
          : audit.sitemapUrlCount >= 1
            ? `${formatNumber(audit.sitemapUrlCount, 0)} URLs`
            : "None",
        ["audit"],
        nothingToSay("Not reachable when the page was read."),
      ),
      field(
        "lastChange",
        "Last change",
        text(audit.lastModified)?.slice(0, 10) ?? null,
        ["audit"],
        nothingToSay("The server published no date for the page."),
      ),
    ],
  };
}

function logGroup(target: TargetRow, entries: number, t: T): FieldGroup {
  return {
    key: "log",
    name: "Yours",
    fields: [
      // `target.state` is a stored key (`spotted`, `engaged`): show the label.
      field(
        "state",
        "Approach state",
        stateLabel(t)[target.state] ?? target.state,
        ["log"],
        nothingToSay("Always set."),
      ),
      field("takenOn", "Taken on", shortDate(target.capturedAt), ["log"], {
        kind: "none",
        reason: "Not taken yet. Record the take from the approach.",
      }),
      field(
        "logEntries",
        "Log entries",
        entries === 0 ? null : formatNumber(entries, 0),
        ["log"],
        {
          kind: "none",
          reason: "Nothing said yet. Move a step in the approach to write one.",
        },
      ),
      field(
        "handEntry",
        "Last hand entry",
        shortDate(target.manualNotedAt),
        ["log"],
        { kind: "none", reason: "You have not typed anything on this record." },
      ),
      field(
        "neighbourhood",
        "Neighbourhood",
        proximityLabel(t)[target.proximity] ?? target.proximity,
        ["computed"],
        nothingToSay("Computed from the businesses already surveyed around."),
      ),
    ],
  };
}

/** Every field, grouped by provider. */
export function fieldInventory(
  target: TargetRow,
  logEntries: number,
  t: T,
): FieldGroup[] {
  return [
    registryGroup(target),
    googleGroup(target),
    auditGroup(target),
    logGroup(target, logEntries, t),
  ];
}

export function countFields(groups: readonly FieldGroup[]): {
  filled: number;
  total: number;
  empty: number;
} {
  let filled = 0;
  let total = 0;

  for (const group of groups) {
    for (const item of group.fields) {
      total += 1;
      if (item.value !== null) filled += 1;
    }
  }

  return { filled, total, empty: total - filled };
}

/** The fields shown above the fold. */
export function primaryFields(
  groups: readonly FieldGroup[],
): TargetField[] {
  return groups.flatMap((group) => group.fields.filter((item) => item.primary));
}
