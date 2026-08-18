import { formatEuros } from "@/lib/format";
import { PRICE_GRID_SCHEMA } from "@/lib/priceGrid";
import type { PriceGrid, PriceOffer } from "@/lib/types";

const CAPPABLE_OFFERS: readonly PriceOffer[] = [
  "base",
  "full-site",
  "multi-page",
  "multi-address",
];

// which offer each one-time-fee tab prices, so its amount can be checked
// against that offer's floor/ceiling before it is ever saved — a value the
// grid would clamp on read is refused on write instead.
const OFFER_BY_FIELD: Partial<Record<string, PriceOffer>> = {
  baseCents: "base",
  fullSiteCents: "full-site",
  multiPageCents: "multi-page",
  multiAddressCents: "multi-address",
};

const EURO_FIELDS = [
  "baseCents",
  "fullSiteCents",
  "multiPageCents",
  "multiAddressCents",
  "perExtraAddressCents",
  "extraAddressCapCents",
  "bookingIntegrationCents",
  "floorCents",
  "ceilingCents",
  "recurringBaseCents",
  "recurringPerExtraAddressCents",
  "recurringCapCents",
] as const;

const COUNT_FIELDS = [
  "valueHorizonMonths",
  "maxAddressesInGrid",
  "complexSiteMinPages",
  "fewReviewsForBase",
] as const;

export function centsToEuros(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const rest = absolute % 100;
  const text =
    rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

function eurosToCents(input: string): number | null {
  const cleaned = input.replace(/[\s  ]/g, "").replace(",", ".");
  if (cleaned === "") return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;

  const negative = cleaned.startsWith("-");
  const [whole = "0", decimals = ""] = cleaned.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0") || "0");

  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function sameGrid(a: PriceGrid, b: PriceGrid): boolean {
  for (const key of [...EURO_FIELDS, ...COUNT_FIELDS] as const) {
    if (a[key] !== b[key]) return false;
  }
  if (a.noPhotoCents !== b.noPhotoCents) return false;

  return (
    [...a.cappedOffers].sort().join(",") === [...b.cappedOffers].sort().join(",")
  );
}

export type GridForm = {
  grid: PriceGrid | null;
  fields: Record<string, string>;
};

export function readGridForm(formData: FormData, base: PriceGrid): GridForm {
  const fields: Record<string, string> = {};
  const raw: Record<string, unknown> = { ...base };

  for (const key of EURO_FIELDS) {
    if (!formData.has(key)) continue;
    const cents = eurosToCents(text(formData, key));
    if (cents === null) {
      fields[key] = "Enter an amount in euros, e.g. 2000 or 2000.50.";
      continue;
    }

    const offer = OFFER_BY_FIELD[key];
    if (offer !== undefined && cents < base.floorCents) {
      fields[key] =
        `Below the ${formatEuros(base.floorCents)} floor — scoring would never charge this low.`;
      continue;
    }
    if (offer !== undefined && base.cappedOffers.includes(offer) && cents > base.ceilingCents) {
      fields[key] =
        `Above the ${formatEuros(base.ceilingCents)} ceiling for this offer — scoring would clamp it back down.`;
      continue;
    }
    if (key === "recurringBaseCents" && cents > base.recurringCapCents) {
      fields[key] =
        `Above the ${formatEuros(base.recurringCapCents)}/month cap — scoring would clamp it back down.`;
      continue;
    }

    raw[key] = cents;
  }

  for (const key of COUNT_FIELDS) {
    if (!formData.has(key)) continue;
    const value = text(formData, key);
    if (!/^\d+$/.test(value)) {
      fields[key] = "Enter a whole number.";
      continue;
    }
    raw[key] = Number(value);
  }

  if (formData.has("noPhotoCents")) {
    const discountEnteredPositive = eurosToCents(text(formData, "noPhotoCents"));
    if (discountEnteredPositive === null || discountEnteredPositive < 0) {
      fields.noPhotoCents = "Enter the discount as a positive amount.";
    } else {
      raw.noPhotoCents = -discountEnteredPositive;
    }
  }

  if (formData.has("cappedOffers")) {
    raw.cappedOffers = formData
      .getAll("cappedOffers")
      .filter((value): value is string => typeof value === "string")
      .filter((value): value is PriceOffer =>
        CAPPABLE_OFFERS.includes(value as PriceOffer),
      );
  }

  if (Object.keys(fields).length > 0) return { grid: null, fields };

  const parsed = PRICE_GRID_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_");
      if (!(key in fields)) fields[key] = issue.message;
    }
    return { grid: null, fields };
  }

  return { grid: parsed.data, fields: {} };
}
