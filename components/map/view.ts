// How the businesses are ordered and which states are shown, in their URL form.
// Read by both the server component and the client map, so it depends on neither
// `server-only` nor the DOM — same contract as `frame.ts`.

import type { useTranslations } from "next-intl";

import type { SortDir, TargetSortKey } from "@/app/queries";
import { TARGET_STATES, type TargetState } from "@/lib/types";

export type TargetView = {
  sort: TargetSortKey;
  dir: SortDir;
  states: readonly TargetState[];
};

// See the note in `text.ts`: structurally compatible with both
// `useTranslations` and `getTranslations`.
type T = ReturnType<typeof useTranslations<"TargetToolbar">>;

/** Declaration order is menu order. Keys are ASCII and reach the URL; `labelKey` never does. */
export const SORT_OPTIONS: ReadonlyArray<{ key: TargetSortKey; labelKey: string }> = [
  { key: "expectancy", labelKey: "sortExpectancy" },
  { key: "loot", labelKey: "sortLoot" },
  { key: "odds", labelKey: "sortOdds" },
  { key: "resistance", labelKey: "sortResistance" },
  { key: "name", labelKey: "sortName" },
  { key: "surveyed", labelKey: "sortSurveyed" },
];

// `dismissed` out: this reproduces exactly what `filterConditions` does with no
// states at all, so the default view is unchanged by this control existing.
export const DEFAULT_STATES: readonly TargetState[] = TARGET_STATES.filter(
  (state) => state !== "dismissed",
);

export const DEFAULT_VIEW: TargetView = {
  sort: "expectancy",
  dir: "desc",
  states: DEFAULT_STATES,
};

const SORT_KEYS = new Set<string>(SORT_OPTIONS.map((option) => option.key));

function sortFrom(raw: string | null | undefined): TargetSortKey {
  return raw && SORT_KEYS.has(raw) ? (raw as TargetSortKey) : DEFAULT_VIEW.sort;
}

function dirFrom(raw: string | null | undefined): SortDir {
  return raw === "asc" ? "asc" : "desc";
}

// An empty or unreadable list falls back to the default. It may NOT fall through
// to `filterConditions`' own empty case: there, no state means "everything except
// dismissed", so `show=` alone would show MORE than the default, not less.
function statesFrom(raw: string | null | undefined): readonly TargetState[] {
  if (!raw) return DEFAULT_STATES;

  const asked = new Set(raw.split(",").map((part) => part.trim()));
  const kept = TARGET_STATES.filter((state) => asked.has(state));
  return kept.length > 0 ? kept : DEFAULT_STATES;
}

/** Never throws: every value here comes off the address bar. */
export function parseView(params: {
  sort?: string | null;
  dir?: string | null;
  show?: string | null;
}): TargetView {
  return {
    sort: sortFrom(params.sort),
    dir: dirFrom(params.dir),
    states: statesFrom(params.show),
  };
}

export function sameStates(
  a: readonly TargetState[],
  b: readonly TargetState[],
): boolean {
  return a.length === b.length && a.every((state) => b.includes(state));
}

// Only what differs from the default is written, so a plain view keeps a clean URL.
export function writeView(params: URLSearchParams, view: TargetView): void {
  if (view.sort !== DEFAULT_VIEW.sort) params.set("sort", view.sort);
  if (view.dir !== DEFAULT_VIEW.dir) params.set("dir", view.dir);
  if (!sameStates(view.states, DEFAULT_STATES)) {
    params.set("show", view.states.join(","));
  }
}

export function sortLabel(sort: TargetSortKey, t: T): string {
  const labelKey = SORT_OPTIONS.find((option) => option.key === sort)?.labelKey ?? "sortExpectancy";
  // `labelKey` is computed at runtime from `SORT_OPTIONS`, not a literal, so it
  // cannot be checked against `T`'s literal key union.
  return (t as (key: string) => string)(labelKey);
}
