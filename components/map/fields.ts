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

function registryGroup(target: TargetRow, t: T): FieldGroup {
  const years = dateFromDay(target.companyCreatedAt);
  const resurvey: FieldAction = { kind: "resurvey", prompt: t("promptSurvey") };

  return {
    key: "registry",
    name: t("groupRegistry"),
    fields: [
      field("siret", "SIRET", target.siret, ["sirene"], nothingToSay(t("alwaysPresent"))),
      field("siren", "SIREN", target.siren, ["sirene"], nothingToSay(t("alwaysPresent"))),
      field("legalName", t("legalName"), text(target.legalName), ["sirene"], resurvey),
      field(
        "naf",
        t("activity"),
        [text(target.naf), text(target.nafLabel)].filter(Boolean).join(" · ") || null,
        ["sirene"],
        resurvey,
      ),
      field(
        "address",
        t("address"),
        [target.address, target.postalCode, target.city].filter(Boolean).join(" · ") || null,
        ["sirene"],
        resurvey,
      ),
      field("founded", t("founded"), years, ["sirene"], resurvey),
      field(
        "establishments",
        t("openEstablishments"),
        target.establishmentCount === null ? null : formatNumber(target.establishmentCount, 0),
        ["sirene"],
        resurvey,
      ),
      field(
        "headcount",
        t("headcountBand"),
        // `NN` is the INSEE code for "not filed", not a band.
        text(target.employeeRange) === "NN" ? null : text(target.employeeRange),
        ["sirene"],
        nothingToSay(t("noHeadcountBand")),
      ),
      field(
        "category",
        t("companyCategory"),
        text(target.companyCategory),
        ["sirene"],
        nothingToSay(t("notClassified")),
      ),
      field(
        "revenue",
        t("revenue"),
        target.revenueCents === null
          ? null
          : `${formatEuros(target.revenueCents, { decimals: "never" })}${target.financesYear ? ` (${target.financesYear})` : ""}`,
        ["sirene"],
        // SIRENE returns `ca: 0` for "accounts not filed". That is an answer,
        // not a gap, so there is no button to offer.
        nothingToSay(t("noAccountsFiledRegistry")),
        true,
      ),
      field(
        "netIncome",
        t("netIncome"),
        target.netIncomeCents === null
          ? null
          : formatEuros(target.netIncomeCents, { decimals: "never" }),
        ["sirene"],
        nothingToSay(t("noAccountsFiled")),
      ),
      field(
        "directors",
        t("directors"),
        target.directors.length === 0
          ? null
          : target.directors
              .map((person) =>
                `${[person.firstNames, person.lastName].filter(Boolean).join(" ")} — ${person.title.toLowerCase()}`.trim(),
              )
              .join(" · "),
        ["sirene"],
        resurvey,
      ),
    ],
  };
}

function googleGroup(target: TargetRow, t: T): FieldGroup {
  const site = chosenSite(target);
  const tel = chosenPhone(target);

  // Google facts are purged past 30 days under Google's terms, so an empty
  // field after a purge is not the same thing as one never queried.
  const prompt = target.googleStale ? t("promptPurgedFetchAgain") : t("promptGoogle");

  return {
    key: "google",
    name: t("groupGoogle"),
    fields: [
      {
        key: "website",
        name: t("website"),
        value: site?.url ?? null,
        // The source badge follows WHO SUPPLIED the value, not the column.
        sources: site ? [site.source] : ["google", "log"],
        action: site
          ? null
          : { kind: "input", field: "website", prompt: t("promptSetWebsite") },
        primary: true,
      },
      {
        key: "phone",
        name: t("phone"),
        value: tel?.number ?? null,
        sources: tel ? [tel.source] : ["google", "log"],
        action: tel
          ? null
          : { kind: "input", field: "phone", prompt: t("promptSetPhone") },
        primary: true,
      },
      field(
        "rating",
        t("rating"),
        target.ratingTenths === null ? null : `${formatRatingTenths(target.ratingTenths)} / 5`,
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "reviews",
        t("reviews"),
        target.reviewCount === null ? null : formatNumber(target.reviewCount, 0),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "priceLevel",
        t("priceLevel"),
        target.priceLevel === null ? null : "€".repeat(Math.max(1, target.priceLevel)),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "hours",
        t("openingHours"),
        target.openingHours?.weekdayDescriptions?.length
          ? t("daysPublished", { count: target.openingHours.weekdayDescriptions.length })
          : null,
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "status",
        t("businessStatus"),
        text(target.businessStatus),
        ["google"],
        { kind: "api", prompt },
      ),
      field(
        "lastQueried",
        t("lastQueried"),
        shortDate(target.googleFetchedAt),
        ["google"],
        { kind: "api", prompt: t("promptGoogle") },
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
function auditGroup(target: TargetRow, t: T): FieldGroup {
  const site = chosenSite(target);
  const audit = target.siteAudit;

  if (!audit) {
    return {
      key: "audit",
      name: t("groupAudit"),
      fields: [
        {
          key: "audit",
          name: t("siteAudit"),
          value: null,
          sources: ["audit"],
          action: site
            ? { kind: "api", prompt: t("promptGoogle") }
            : {
                kind: "input",
                field: "website",
                prompt: t("promptNoAddressSetWebsite"),
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
        ? nothingToSay(t("markerNotFound"))
        : null,
    primary: false,
  });

  return {
    key: "audit",
    name: t("groupAudit"),
    fields: [
      field("url", t("auditedAddress"), text(audit.url), ["audit"], {
        kind: "input",
        field: "website",
        prompt: t("promptSetWebsite"),
      }),
      field("auditedOn", t("auditedOn"), shortDate(target.auditedAt), ["audit"], {
        kind: "api",
        prompt: t("promptGoogle"),
      }),
      field("tech", t("technology"), text(audit.tech), ["audit"], nothingToSay(
        t("noTechMarker"),
      )),
      mark("https", "HTTPS", audit.https, t("yes"), t("no")),
      mark("viewport", t("mobileViewport"), audit.viewport, t("yes"), t("no")),
      mark("title", t("title"), audit.titleFilled, t("filledIn"), t("emptyOrGeneric")),
      mark(
        "structuredData",
        t("structuredData"),
        audit.structuredData,
        t("present"),
        t("absent"),
      ),
      mark("theme", t("theme"), audit.defaultTheme, t("defaultUntouched"), t("custom")),
      mark("photos", t("usablePhotos"), audit.usablePhotos, t("yes"), t("no")),
      mark("agency", t("agencyCredited"), audit.agencyDetected, t("yes"), t("no")),
      mark("onlineSales", t("onlineSales"), audit.onlineSales, t("yes"), t("no")),
      mark("onlineBooking", t("onlineBooking"), audit.onlineBooking, t("yes"), t("no")),
      field(
        "sitemap",
        t("sitemap"),
        audit.sitemapUrlCount === undefined
          ? null
          : audit.sitemapUrlCount >= 1
            ? t("sitemapUrls", { count: audit.sitemapUrlCount })
            : t("none"),
        ["audit"],
        nothingToSay(t("sitemapNotReachable")),
      ),
      field(
        "lastChange",
        t("lastChange"),
        text(audit.lastModified)?.slice(0, 10) ?? null,
        ["audit"],
        nothingToSay(t("noPublishedDate")),
      ),
    ],
  };
}

function logGroup(target: TargetRow, entries: number, t: T): FieldGroup {
  return {
    key: "log",
    name: t("groupLog"),
    fields: [
      // `target.state` is a stored key (`spotted`, `engaged`): show the label.
      field(
        "state",
        t("approachState"),
        stateLabel(t)[target.state] ?? target.state,
        ["log"],
        nothingToSay(t("alwaysSet")),
      ),
      field("takenOn", t("takenOn"), shortDate(target.capturedAt), ["log"], {
        kind: "none",
        reason: t("notTakenYet"),
      }),
      field(
        "logEntries",
        t("logEntries"),
        entries === 0 ? null : formatNumber(entries, 0),
        ["log"],
        {
          kind: "none",
          reason: t("nothingSaidYet"),
        },
      ),
      field(
        "handEntry",
        t("lastHandEntry"),
        shortDate(target.manualNotedAt),
        ["log"],
        { kind: "none", reason: t("nothingTypedYet") },
      ),
      field(
        "neighbourhood",
        t("neighbourhood"),
        proximityLabel(t)[target.proximity] ?? target.proximity,
        ["computed"],
        nothingToSay(t("computedFromNearby")),
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
    registryGroup(target, t),
    googleGroup(target, t),
    auditGroup(target, t),
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
