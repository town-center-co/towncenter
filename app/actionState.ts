// Form-state types live outside app/actions.ts because a "use server" module
// that re-exports an imported type emits a runtime re-export of an erased
// identifier: tsc passes, the build passes, the page dies on the first click.
// Amounts are integer cents; keys are ASCII, only messages are visible text.

import type { EventKind, TargetState } from "@/lib/types";

/** One harvest slice. The client loops while `nextPage` is not null. */
export type SurveyResult = {
  kind: "harvest";
  zoneId: string;
  page: number;
  nextPage: number | null;
  found: number;
  created: number;
  requests: number;
  /** `total_results` as announced by the API: a floor, not a total. */
  totalResults: number;
  truncated: boolean;
  /** the API caps at 10 000 results: the sector is too wide, cut it up. */
  saturated: boolean;
  outsidePolygon: number;
  /** a page failed after others were written; `nextPage` resumes there. */
  interrupted: boolean;
};

export type EnrichResult = {
  kind: "enrichment";
  enriched: number;
  /** only what is really queryable: mixing in `unreachable` loops the client forever. */
  remaining: number;
  /** nothing to query: no Google address, no website. Never stamped as audited. */
  unreachable: number;
  // Google facts expire at 30 days: hiding them on read is not enough, the
  // terms require deletion, which `purged` counts.
  googleUsed: boolean;
  purged: number;
  budgetSpent: boolean;
};

export type AdvanceResult = {
  kind: "advance";
  targetId: string;
  targetName: string;
  from: TargetState;
  to: TargetState;
  event: EventKind;
  valueCents: number | null;
  /** null, never 0, when off grid: an off-grid target is not a 0 EUR target. */
  recurringCents: number | null;
  /** the sector's hold as whole percentages, null when no sector contains it. */
  holdBefore: number | null;
  holdAfter: number | null;
  zoneLabel: string | null;
};

export type DismissResult = {
  kind: "dismiss";
  targetId: string;
  targetName: string;
  dismissed: boolean;
};

// undoes the last fact and only the last: the row is erased from the ledger,
// never compensated, or the take keeps summing into banked revenue.
export type UndoResult = {
  kind: "undo";
  targetId: string;
  targetName: string;
  from: TargetState;
  to: TargetState;
  erasedEvent: EventKind;
  erasedValueCents: number | null;
  remainingEvents: number;
};

export type SectorResult = {
  kind: "sector";
  zoneId: string;
  /** visible text, null when cleared: the sector reverts to its date. */
  label: string | null;
};

// No undo: the confirmation dialog in the UI is the only guard.
export type DeleteZoneResult = {
  kind: "delete-zone";
  zoneId: string;
  label: string | null;
  targetsDeleted: number;
};

export type ActionResult =
  | SurveyResult
  | EnrichResult
  | AdvanceResult
  | DismissResult
  | UndoResult
  | SectorResult
  | DeleteZoneResult;

// useActionState puts the previous state FIRST, before the FormData:
// (previousState: ActionState, formData: FormData) => Promise<ActionState>.
export type ActionState = {
  status: "idle" | "success" | "error";
  message: string | null;
  /**
   * Stable ASCII id for `message`, set alongside it. `message` is already
   * translated (never asserted on directly) — benches assert on this instead,
   * so a copy edit to `message` never breaks a test. Never translated itself.
   */
  messageKey: string | null;
  /** keyed by the control's `name` attribute. */
  fieldErrors: Record<string, string>;
  values: Record<string, string>;
  /** an interrupted job returns a `result` with `status: "error"`; clearing it loses `nextPage`. */
  result: ActionResult | null;
  /** render key: React clears uncontrolled fields after an action, and equal states must still replay. */
  token: number;
};

export const initialActionState: ActionState = {
  status: "idle",
  message: null,
  messageKey: null,
  fieldErrors: {},
  values: {},
  result: null,
  token: 0,
};

// field names each action expects: a misspelled `name` on an <input> raises no
// error, only an empty value.

export const SURVEY_FIELDS = [
  "frame",
  "contour",
  "naf",
  "label",
  "zoneId",
  "page",
] as const;

export const ENRICH_ZONE_FIELDS = ["frame"] as const;
export const ENRICH_TARGET_FIELDS = ["id"] as const;
/** `field` is an ASCII key (`website` | `phone`), not a label. */
export const NOTE_FIELDS = ["id", "field", "value"] as const;
export const ADVANCE_FIELDS = ["id", "to", "amount", "note"] as const;
export const DISMISS_FIELDS = ["id"] as const;
export const UNDO_FIELDS = ["id"] as const;
export const RENAME_FIELDS = ["id", "label"] as const;
export const DELETE_ZONE_FIELDS = ["id"] as const;
