// dates go through the locale and time zone pinned in lib/format.ts. Intl
// without an explicit timeZone reads the machine's, so the server and the
// browser render two different strings and every date mismatches on hydration.

import type { useTranslations } from "next-intl";

import { LOCALE, TIME_ZONE } from "@/lib/format";
import type { EventKind, TargetState } from "@/lib/types";

// Structurally compatible with both `useTranslations` (client) and
// `getTranslations` (server) — these label builders are called from both.
type T = ReturnType<typeof useTranslations<"TargetLabels">>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, ...options });
    formatters.set(key, found);
  }
  return found;
}

export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatter({ day: "2-digit", month: "2-digit" }).format(date);
}

export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatter({ day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/** a SIRENE `YYYY-MM-DD` date, read at noon UTC so the day never shifts. */
export function dateFromDay(day: string | null | undefined): string | null {
  if (!day) return null;
  return longDate(`${day}T12:00:00.000Z`);
}

export function yearsSince(
  day: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!day) return null;
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const years = (now.getTime() - date.getTime()) / (365.25 * 86_400_000);
  return years < 0 ? 0 : years;
}

// the keys are stored in the database and drive `data-*` attributes; only the
// labels are visible text. Built per call, not at module scope: the labels
// come from the request's locale, which is only available once a translator
// has been resolved (`useTranslations("TargetLabels")` or
// `getTranslations("TargetLabels")`).

export function stateLabel(t: T): Record<TargetState, string> {
  return {
    spotted: t("stateSpotted"),
    studied: t("stateStudied"),
    engaged: t("stateEngaged"),
    taken: t("stateTaken"),
    withdrawn: t("stateWithdrawn"),
    dismissed: t("stateDismissed"),
  };
}

export function approach(t: T): readonly { state: TargetState; label: string }[] {
  return [
    { state: "spotted", label: t("stateSpotted") },
    { state: "studied", label: t("stateStudied") },
    { state: "engaged", label: t("stateEngaged") },
    { state: "taken", label: t("stateTaken") },
  ];
}

export function eventLabel(t: T): Record<EventKind, string> {
  return {
    survey: t("eventSurvey"),
    study: t("eventStudy"),
    contact: t("eventContact"),
    reply: t("eventReply"),
    take: t("eventTake"),
    withdrawal: t("eventWithdrawal"),
  };
}

export function advanceVerb(
  t: T,
): Record<"studied" | "engaged" | "taken" | "withdrawn", string> {
  return {
    studied: t("advanceStudied"),
    engaged: t("advanceEngaged"),
    taken: t("advanceTaken"),
    withdrawn: t("advanceWithdrawn"),
  };
}

export function stepVerb(t: T): Record<"studied" | "engaged" | "taken", string> {
  return {
    studied: t("stepStudied"),
    engaged: t("stepEngaged"),
    taken: t("stepTaken"),
  };
}

// dates a step from the log; inverse of STATE_FOR_EVENT on the server side,
// and the two must stay consistent.
export const STEP_EVENT: Record<TargetState, EventKind | null> = {
  spotted: "survey",
  studied: "study",
  engaged: "contact",
  taken: "take",
  withdrawn: "withdrawal",
  dismissed: null,
};

export function proximityLabel(t: T): Record<string, string> {
  return {
    "same-street-capture": t("proximitySameStreetCapture"),
    "near-live-deal": t("proximityNearLiveDeal"),
    "in-zone": t("proximityInZone"),
    "outside-zone": t("proximityOutsideZone"),
  };
}

export function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

const numberFormatters = new Map<number, Intl.NumberFormat>();

// pinned locale: toLocaleString() without one reads the browser's and renders
// "1.8" against the server's "1,8".
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  let formatter = numberFormatters.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: decimals });
    numberFormatters.set(decimals, formatter);
  }
  return formatter.format(value);
}

export function distance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${formatNumber(metres / 1000, 1)} km`;
}
