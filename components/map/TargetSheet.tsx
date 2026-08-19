"use client";

/*
 * The record for one business: right-hand drawer on desktop, bottom sheet on
 * phone. A fixed head plus three tabs — Approach, Facts, Log.
 *
 * The resistance percentage in the head is a CONTROL: clicking it opens Facts
 * and scrolls to the factor product. A figure that cannot be explained must not
 * be shown, so that path has to stay reachable from the number itself.
 */

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  useActionState,
} from "react";
import { toast } from "sonner";

import {
  advanceTargetAction,
  dismissTargetAction,
  enrichTargetAction,
  noteTargetFieldAction,
  restoreTargetAction,
  rollbackTargetAction,
} from "@/app/actions";
import { initialActionState, type AdvanceResult } from "@/app/actionState";
import type { TargetDetail } from "@/app/queries";
import {
  Button,
  ConfirmDialog,
  Loot,
  Stamp,
  Difficulty,
  Badge,
  Fact,
  SourceLegend,
  Source,
  Sources,
  percent,
  resistanceBand,
  BAND_LABEL_KEY,
  Spinner,
  type SourceKey,
} from "@/components/ui";
import { formatEuros } from "@/lib/format";
import { PRICE_OFFER_LABELS } from "@/lib/scoring";
import { TARGET_STATE_RANK, type TargetState } from "@/lib/types";

import {
  primaryFields,
  countFields,
  fieldInventory,
  type FieldAction,
  type TargetField,
} from "./fields";
import { fiveFacts, recordedFacts } from "./facts";
import { sheetAsMarkdown } from "./prompt";
import { useTranslations } from "next-intl";

import {
  approach,
  STEP_EVENT,
  stateLabel,
  eventLabel,
  advanceVerb,
  stepVerb,
  distance,
  shortDate,
  formatNumber,
} from "./text";

export type TargetSheetProps = {
  detail: TargetDetail;
  /** Outcomes recorded. Below 30 the resistance is uncalibrated and says so. */
  outcomeCount: number;
  onClose: () => void;
  /** Opens a neighbour without going through the map. */
  onSelect: (id: string) => void;
};

/** ASCII keys: they drive `data-tab` attributes. */
type Tab = "approach" | "facts" | "log";

const TABS: readonly { key: Tab; labelKey: string }[] = [
  { key: "approach", labelKey: "tabApproach" },
  { key: "facts", labelKey: "tabFacts" },
  { key: "log", labelKey: "tabLog" },
];

/** Steps reachable from a given state. `withdrawn` stays available regardless. */
function nextStepsFor(state: TargetState): ("studied" | "engaged" | "taken")[] {
  const rank = TARGET_STATE_RANK[state];
  return (["studied", "engaged", "taken"] as const).filter(
    (to) => TARGET_STATE_RANK[to] > rank,
  );
}

export function TargetSheet({
  detail,
  outcomeCount,
  onClose,
  onSelect,
}: TargetSheetProps) {
  const { target: target, log, neighbours } = detail;

  const tLabels = useTranslations("TargetLabels");
  const APPROACH = approach(tLabels);
  const STATE_LABEL = stateLabel(tLabels);
  const EVENT_LABEL = eventLabel(tLabels);
  const ADVANCE_VERB = advanceVerb(tLabels);
  const STEP_VERB = stepVerb(tLabels);
  const tSheet = useTranslations("TargetSheet");
  const tFacts = useTranslations("Facts");
  const tDifficulty = useTranslations("Difficulty");
  const tFactor = useTranslations("SuccessFactors");

  const [advanceState, advance, advancePending] = useActionState(
    advanceTargetAction,
    initialActionState,
  );
  const [dismissState, dismiss, dismissPending] = useActionState(
    dismissTargetAction,
    initialActionState,
  );
  const [restoreState, restore, restorePending] = useActionState(
    restoreTargetAction,
    initialActionState,
  );
  const [enrichState, enrich, enrichPending] = useActionState(
    enrichTargetAction,
    initialActionState,
  );
  // `restoreState` already means putting a dismissed target back in play; this
  // one undoes an entry in the log, which is unrelated.
  const [undoState, undo, undoPending] = useActionState(
    rollbackTargetAction,
    initialActionState,
  );
  const [noteState, saveNote, notePending] = useActionState(
    noteTargetFieldAction,
    initialActionState,
  );

  const [tab, setTab] = useState<Tab>("approach");
  /** Open form: a take asks for an amount, a withdrawal for a reason. */
  const [input, setInput] = useState<"taken" | "withdrawn" | null>(null);
  const [stamp, setStamp] = useState<AdvanceResult | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  /** Copy button state. `manual` means the clipboard was refused. */
  const [copied, setCopied] = useState<"idle" | "fact" | "manual">("idle");
  /** ASCII key of the field being edited, or `null`. */
  const [editing, setEditing] = useState<"website" | "phone" | null>(null);

  // The stamp fires on the TOKEN, not on the state object: `ActionState.token`
  // increments on every reply, which is what lets the same business be
  // celebrated twice in a row.
  const lastAdvanceToken = useRef(advanceState.token);
  useEffect(() => {
    if (advanceState.token === lastAdvanceToken.current) return;
    lastAdvanceToken.current = advanceState.token;

    if (advanceState.status === "error") {
      if (advanceState.message) toast.error(advanceState.message);
      return;
    }

    const result = advanceState.result;
    if (result?.kind !== "advance") return;

    setInput(null);
    // Only a take and its counterpart the withdrawal are stamped; marking a
    // target as studied is not an event, and gets a toast instead.
    if (result.to === "taken" || result.to === "withdrawn") {
      setStamp(result);
    } else if (advanceState.message) {
      toast.success(advanceState.message);
    }
  }, [advanceState]);

  const lastDismissToken = useRef(dismissState.token);
  useEffect(() => {
    if (dismissState.token === lastDismissToken.current) return;
    lastDismissToken.current = dismissState.token;
    if (dismissState.status === "success" && dismissState.message) {
      toast.success(dismissState.message);
    } else if (dismissState.status === "error" && dismissState.message) {
      toast.error(dismissState.message);
    }
  }, [dismissState]);

  const lastRestoreToken = useRef(restoreState.token);
  useEffect(() => {
    if (restoreState.token === lastRestoreToken.current) return;
    lastRestoreToken.current = restoreState.token;
    if (restoreState.status === "success" && restoreState.message) {
      toast.success(restoreState.message);
    } else if (restoreState.status === "error" && restoreState.message) {
      toast.error(restoreState.message);
    }
  }, [restoreState]);

  const lastEnrichToken = useRef(enrichState.token);
  useEffect(() => {
    if (enrichState.token === lastEnrichToken.current) return;
    lastEnrichToken.current = enrichState.token;
    if (enrichState.status === "success" && enrichState.message) {
      toast.success(enrichState.message);
    } else if (enrichState.status === "error" && enrichState.message) {
      toast.error(enrichState.message);
    }
  }, [enrichState]);

  const lastUndoToken = useRef(undoState.token);
  useEffect(() => {
    if (undoState.token === lastUndoToken.current) return;
    lastUndoToken.current = undoState.token;
    if (undoState.status === "success" && undoState.message) {
      toast.success(undoState.message);
    } else if (undoState.status === "error" && undoState.message) {
      toast.error(undoState.message);
    }
  }, [undoState]);

  // Every figure below is recomputed on read; none is stored.
  const price = target.score.price;
  const success = target.score.success;
  const offGrid = price.kind === "off-grid";
  const band = resistanceBand(target.resistancePercent);
  const facts = fiveFacts(target, new Date(), tFacts);
  const available = recordedFacts(facts);

  const groups = fieldInventory(target, log.length, tLabels);
  const counting = countFields(groups);
  const main = primaryFields(groups);

  // Only the sources this record actually cites. `sirene` and `computed` are
  // always present; the others appear only if they supplied something, so the
  // legend never implies Google answered when it never ran.
  const citedSources: SourceKey[] = [
    "sirene",
    ...facts.flatMap((fact) => (fact.value === null ? [] : fact.sources)),
    ...(target.manualWebsiteUrl || target.manualPhone ? (["log"] as const) : []),
    ...(log.length > 0 ? (["log"] as const) : []),
    "computed",
  ];

  const inProgress =
    advancePending ||
    dismissPending ||
    restorePending ||
    enrichPending ||
    undoPending ||
    notePending;

  // The confirmation closes on the TOKEN, never on `target.state`: the state
  // comes back from the server one render late, so trusting it would leave the
  // panel open on an already-erased entry and a second click would erase the
  // one before it.
  const undoToken = useRef(undoState.token);
  useEffect(() => {
    if (undoState.token === undoToken.current) return;
    undoToken.current = undoState.token;
    setConfirmUndo(false);
  }, [undoState]);

  // The input closes when the action REPLIED, not when the value comes back:
  // `target.manualWebsiteUrl` arrives one render late, and a field left open
  // over its own saved value invites retyping it.
  const noteToken = useRef(noteState.token);
  useEffect(() => {
    if (noteState.token === noteToken.current) return;
    noteToken.current = noteState.token;
    if (noteState.status === "success") {
      setEditing(null);
      if (noteState.message) toast.success(noteState.message);
    } else if (noteState.status === "error" && noteState.message) {
      toast.error(noteState.message);
    }
  }, [noteState]);

  // The sheet is not remounted between businesses, it is the same node with new
  // props, so every transient state has to be reset by hand.
  useEffect(() => {
    setConfirmUndo(false);
    setCopied("idle");
    setInput(null);
    setEditing(null);
    setTab("approach");
  }, [target.id]);

  const calculationRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [highlightCalculation, setHighlightCalculation] = useState(false);

  // Two passes are required: the calculation block is not in the DOM until the
  // Facts tab is mounted, so scrolling in the same tick would silently target a
  // missing node. Switch tab, raise a flag, scroll once the panel is painted.
  const openCalculation = useCallback(() => {
    setTab("facts");
    setHighlightCalculation(true);
  }, []);

  useEffect(() => {
    if (!highlightCalculation || tab !== "facts") return;
    setHighlightCalculation(false);

    const body = bodyRef.current;
    const anchor = calculationRef.current;
    if (!body || !anchor) return;

    // Never `scrollIntoView` here: it scrolls EVERY scrollable ancestor up to
    // the document, and `overflow: hidden` does not stop programmatic scroll.
    // `.territory` is `height: 100dvh; overflow: hidden`, so the whole app
    // would slide with no scrollbar left to bring it back. Compute the offset
    // by hand and scroll only `.sheet__body`.
    const top =
      anchor.getBoundingClientRect().top -
      body.getBoundingClientRect().top +
      body.scrollTop;

    body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [highlightCalculation, tab]);

  /**
   * The last log entry, when it can be undone. `log` breaks same-second ties by
   * insertion order, exactly like the undo action: both must designate the same
   * entry or the screen announces erasing one thing while the server erases
   * another. A `survey` entry is excluded because it is not a gesture — the
   * harvest writes one per discovered business, and the action refuses it too.
   */
  const lastEvent =
    log[0] && log[0].kind !== "survey" ? log[0] : null;

  /**
   * Date of the log entry that justifies a step, or `null`. Read from the log,
   * not the state: a past step carries the date it was CROSSED. The log is most
   * recent first, so the first crossing is the last occurrence in read order.
   */
  const stepDate = (state: TargetState): string | null => {
    const kind = STEP_EVENT[state];
    if (!kind) return null;
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const entry = log[index]!;
      if (entry.kind === kind) return shortDate(entry.occurredAt);
    }
    return null;
  };

  /** Crosses a step; a take asks for its amount first. */
  const cross = (to: "studied" | "engaged" | "taken") => {
    setConfirmUndo(false);
    setTab("approach");
    if (to === "taken") {
      setInput(input === "taken" ? null : "taken");
      return;
    }
    const data = new FormData();
    data.set("id", target.id);
    data.set("to", to);
    // Required: a `useActionState` action called outside a transition leaves
    // `advancePending` at `false` forever, so `disabled` never bites and two
    // fast clicks both go through.
    startTransition(() => advance(data));
  };

  const copyAsPrompt = async () => {
    const text = sheetAsMarkdown(detail, outcomeCount);
    try {
      // `navigator.clipboard` only exists in a secure context. Over plain HTTP
      // on a LAN address the property is absent entirely, so it has to be
      // tested before awaiting it.
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied("fact");
    } catch {
      // Refused, insecure context, permission revoked: show the text instead of
      // leaving a button that does nothing.
      setCopied("manual");
    }
  };

  /** Fetches the facts. Rendered in the head AND in the Facts tab. */
  const enrichButton = (
    <form action={enrich}>
      <input type="hidden" name="id" value={target.id} />
      <Button type="submit" variant="quiet" size="compact" disabled={inProgress}>
        {enrichPending && <Spinner />}
        {target.enriched ? tSheet("refreshTheFacts") : tSheet("fetchTheFacts")}
      </Button>
    </form>
  );

  // One field row: on the right, either the value or the action that would
  // fill it. Never a silent blank.
  const fieldRow = (item: TargetField) => (
    <div className="field" key={item.key} data-field={item.key} data-empty={item.value === null ? "yes" : "no"}>
      <span className="t-body-s field__name">{item.name}</span>
      <span className="field__value">
        {item.value !== null ? (
          <>
            <span className="t-body field__text">{item.value}</span>
            <Sources keys={item.sources} />
          </>
        ) : (
          fieldAction(item)
        )}
      </span>
    </div>
  );

  const fieldAction = (item: TargetField) => {
    const action = item.action as FieldAction | null;
    if (!action) return <span className="t-body field__empty">—</span>;

    switch (action.kind) {
      // One enrich button for the whole sheet: repeating it on the eight Google
      // rows would give eight buttons firing the same call. The row states what
      // would fill it, the button sits at the top of the tab.
      case "api":
        return (
          <button
            type="button"
            className="t-body field__action"
            disabled={inProgress}
            aria-busy={enrichPending || undefined}
            onClick={() => {
              const data = new FormData();
              data.set("id", target.id);
              startTransition(() => enrich(data));
            }}
          >
            {/* The clicked row says it is working: a Google call takes over a
                second and would otherwise read as a dead click. */}
            {enrichPending && <Spinner />}
            {action.prompt}
          </button>
        );

      case "input":
        return editing === action.field ? (
          <form action={saveNote} className="field__entry">
            <input type="hidden" name="id" value={target.id} />
            <input type="hidden" name="field" value={action.field} />
            <input
              name="value"
              className="field__input t-body"
              autoComplete="off"
              /* `autoFocus` scrolls every ancestor, like `scrollIntoView`, and
                 `.territory` is `overflow: hidden` with no scrollbar to come
                 back. `preventScroll` focuses without scrolling; the field was
                 just opened by a click so it is already in view. */
              ref={(node) => {
                node?.focus({ preventScroll: true });
              }}
              inputMode={action.field === "phone" ? "tel" : "url"}
              placeholder={
                action.field === "website" ? "boulangerie-durand.fr" : "01 99 00 00 00"
              }
              defaultValue={
                (action.field === "website"
                  ? target.manualWebsiteUrl
                  : target.manualPhone) ?? ""
              }
            />
            <Button type="submit" variant="secondary" size="compact" disabled={inProgress}>
              {notePending && <Spinner />}
              {tSheet("save")}
            </Button>
            <Button variant="quiet" size="compact" onClick={() => setEditing(null)}>
              {tSheet("cancel")}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="t-body field__action"
            onClick={() => setEditing(action.field)}
          >
            {action.prompt}
          </button>
        );

      case "resurvey":
        return (
          <span className="t-body-s field__reason">
            {tSheet("resurveyToBringIn")}
          </span>
        );

      case "none":
        return <span className="t-body-s field__reason">{action.reason}</span>;
    }
  };

  const upcoming = nextStepsFor(target.state)[0] ?? null;

  return (
    <aside className="sheet" aria-label={tSheet("recordForAria", { name: target.name })}>
      <header className="sheet__head">
        <div className="sheet__head-top">
          <p className="t-body-s tone-2">{target.lootReason}</p>
          <Button
            variant="quiet"
            size="compact"
            className="sheet__close"
            onClick={onClose}
            aria-label={tSheet("closeRecordAria")}
          >
            ✕
          </Button>
        </div>

        <h2 className="t-title-2 sheet__name">
          {target.name}
          <Source sourceKey="sirene" />
        </h2>
        <p className="t-body-s tone-2 sheet__address">
          {[target.address, target.postalCode, target.city].filter(Boolean).join(" · ") ||
            tSheet("addressUnknown")}
          <Source sourceKey="sirene" />
        </p>

        {/* The two questions, side by side and nothing else. */}
        <div className="sheet__figures">
          <div className="sheet__figure">
            <Loot
              cents={price.value12MonthsCents}
              recurringCents={offGrid ? null : price.recurringCents}
              // `value12MonthsCents` IS `price + 12 x recurring`; the default
              // "+" would read as 3 080 + 12 x 90 = 4 160 EUR.
              recurringIncluded
              size="title"
              label={tSheet("spoilsOver12Months")}
              offGrid={offGrid}
              reason={offGrid ? price.reason : null}
            />
            {/* The breakdown stays under the total: shown alone, the total sits
                right below a chip announcing a different expected amount and
                the two read as a contradiction. */}
            {offGrid ? null : (
              <p className="t-body-s tone-2 sheet__breakdown">
                {tSheet("signatureThenMonthly", {
                  price: formatEuros(price.priceCents, { decimals: "never" }),
                  recurring: formatEuros(price.recurringCents, { decimals: "never" }),
                })}
                <Source sourceKey="computed" />
              </p>
            )}
          </div>

          {/* This is a button, and that is the price of tabbing: the factor
              product is one click away, and the click is on the number itself.
              `Difficulty` keeps the "not calibrated, n = X" mention. */}
          <button
            type="button"
            className="sheet__figure sheet__to-calculation"
            onClick={openCalculation}
          >
            <Difficulty
              resistance={target.resistancePercent / 100}
              issues={outcomeCount}
              facts={{ available, total: facts.length }}
              variant="bar"
              wording="resistance"
            />
            <span className="t-body-s sheet__to-calculation-prompt">
              {tSheet("howBuiltPrompt")}
            </span>
          </button>
        </div>

        {/* The gesture for the current step, full width. It answers "and now?"
            and must not require scrolling. */}
        {target.state === "dismissed" ? (
          <form action={restore} className="sheet__action">
            <input type="hidden" name="id" value={target.id} />
            <Button type="submit" variant="primary" disabled={inProgress}>
              {tSheet("putBackInPlay")}
            </Button>
          </form>
        ) : upcoming ? (
          <div className="sheet__action">
            <Button
              variant="primary"
              disabled={inProgress}
              onClick={() => cross(upcoming)}
            >
              {ADVANCE_VERB[upcoming]}
            </Button>
          </div>
        ) : null}
      </header>

      <div className="sheet__tabs" role="tablist" aria-label={tSheet("recordSectionsAria")}>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`sheet-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={`sheet-panel-${item.key}`}
            className="sheet__tab"
            onClick={() => setTab(item.key)}
          >
            <Badge>{tSheet(item.labelKey as Parameters<typeof tSheet>[0])}</Badge>
            {item.key === "log" && log.length > 0 ? (
              <span className="t-micro tnum sheet__tab-count">{log.length}</span>
            ) : null}
            {item.key === "facts" && counting.empty > 0 ? (
              <span className="t-micro tnum sheet__tab-count">
                {counting.filled}/{counting.total}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="sheet__body" ref={bodyRef}>
        {tab === "approach" ? (
          <div
            role="tabpanel"
            id="sheet-panel-approach"
            aria-labelledby="sheet-tab-approach"
            className="sheet__panel"
          >
            {offGrid ? (
              <p className="sheet__alert t-body">
                {tSheet.rich("offGridAlert", {
                  reason: price.reason,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
                <Source sourceKey="computed" />
              </p>
            ) : null}

            <section className="sheet__section">
              {/* The staircase is the control, not an illustration: a FUTURE
                  step is the button that leads there and carries the concrete
                  verb, a PAST step carries its date, the CURRENT step carries
                  its date and its undo. */}
              <ol className="sheet__steps" data-state={target.state}>
                {APPROACH.map((step) => {
                  const rank = TARGET_STATE_RANK[step.state];
                  const currentRank = TARGET_STATE_RANK[target.state];
                  // `withdrawn` and `dismissed` are -1 and -2, so no step is
                  // reached by their rank; fall back to the log, which says what
                  // actually happened before the exit.
                  const reached =
                    currentRank >= 0 ? rank <= currentRank : stepDate(step.state) !== null;
                  const current = currentRank >= 0 && rank === currentRank;
                  const day = stepDate(step.state);

                  const position = reached ? (current ? "current" : "past") : "future";

                  // A future step is only offered when it is really open: a
                  // button that leaves only to be refused reads as a gesture
                  // that was accepted.
                  const workday =
                    position === "future" &&
                    step.state !== "spotted" &&
                    nextStepsFor(target.state).includes(
                      step.state as "studied" | "engaged" | "taken",
                    );

                  const undoable =
                    position === "current" &&
                    lastEvent !== null &&
                    STEP_EVENT[step.state] === lastEvent.kind;

                  const content = (
                    <>
                      <span className="sheet__step-dot" aria-hidden="true" />
                      <span className="t-body sheet__step-name">{step.label}</span>
                      <span className="t-micro tnum sheet__step-right">
                        {position === "future"
                          ? workday
                            ? STEP_VERB[step.state as "studied" | "engaged" | "taken"]
                            : ""
                          : [day, undoable ? tSheet("undo") : null].filter(Boolean).join(" · ")}
                      </span>
                    </>
                  );

                  return (
                    <li key={step.state} data-position={position}>
                      {workday ? (
                        <button
                          type="button"
                          className="sheet__step"
                          disabled={inProgress}
                          onClick={() =>
                            cross(step.state as "studied" | "engaged" | "taken")
                          }
                        >
                          {content}
                          <span className="sr-only">
                            {` — ${ADVANCE_VERB[step.state as "studied" | "engaged" | "taken"]}`}
                          </span>
                        </button>
                      ) : undoable ? (
                        <button
                          type="button"
                          className="sheet__step"
                          disabled={inProgress}
                          aria-expanded={confirmUndo}
                          onClick={() => setConfirmUndo((open) => !open)}
                        >
                          {content}
                          <span className="sr-only"> {tSheet("undoThisFactAria")}</span>
                        </button>
                      ) : (
                        <span className="sheet__step">{content}</span>
                      )}
                    </li>
                  );
                })}
              </ol>

              {target.state === "withdrawn" ? (
                <p className="t-body-s sheet__fold">{tSheet("withdrawnFold")}</p>
              ) : null}
              {target.state === "dismissed" ? (
                <p className="t-body-s tone-2">{tSheet("dismissedFold")}</p>
              ) : null}
              {target.state === "taken" ? (
                <p className="t-body-s tone-success">
                  {target.capturedAt
                    ? tSheet("takenOnFold", { date: shortDate(target.capturedAt) ?? "" })
                    : tSheet("takenFold")}
                </p>
              ) : null}

              {/* Only the offer name. The amount lives in the head, under the
                  total it breaks down: repeating it here would put the same
                  figure in two places. */}
              {offGrid ? null : (
                <p className="t-body-s tone-2">
                  {tSheet("offerRetained", { offer: PRICE_OFFER_LABELS[price.offer] })}
                  <Source sourceKey="computed" />
                </p>
              )}

              {target.state === "dismissed" ? null : (
                <>
                  {/* The exits end the approach rather than continue it, so
                      they sit one level down. The "Exits" label is on its own
                      row: on the button row nothing at rest told which of the
                      three words was clickable. */}
                  <div className="sheet__exits">
                    <Badge>{tSheet("exits")}</Badge>
                    <div className="sheet__exit-actions">
                      {target.state === "withdrawn" ? null : (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={inProgress}
                          aria-expanded={input === "withdrawn"}
                          onClick={() => {
                            setConfirmUndo(false);
                            setInput(input === "withdrawn" ? null : "withdrawn");
                          }}
                        >
                          {ADVANCE_VERB.withdrawn}
                        </Button>
                      )}

                      <form action={dismiss}>
                        <input type="hidden" name="id" value={target.id} />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="compact"
                          disabled={inProgress}
                        >
                          {tSheet("setAside")}
                        </Button>
                      </form>
                    </div>
                  </div>

                  <ConfirmDialog
                    open={confirmUndo && lastEvent !== null}
                    title={tSheet("undoLastFactTitle")}
                    onCancel={() => setConfirmUndo(false)}
                    className="confirm-dialog__card--danger"
                  >
                    {lastEvent ? (
                      <>
                        <p className="t-body tnum">
                          {tSheet("eventOnDate", {
                            event: EVENT_LABEL[lastEvent.kind],
                            date: shortDate(lastEvent.occurredAt) ?? "?",
                          })}
                          {lastEvent.valueCents !== null
                            ? ` · ${formatEuros(lastEvent.valueCents, { decimals: "never" })}`
                            : ""}
                        </p>
                        {lastEvent.note ? (
                          <p className="t-body-s tone-2">{lastEvent.note}</p>
                        ) : null}
                        <p className="t-body-s tone-3">{tSheet("actionCannotBeUndone")}</p>
                        <form action={undo} className="sheet__actions">
                          <input type="hidden" name="id" value={target.id} />
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={inProgress}
                            onClick={() => setConfirmUndo(false)}
                          >
                            {tSheet("keep")}
                          </Button>
                          <Button type="submit" variant="danger" disabled={inProgress}>
                            {undoPending && <Spinner />}
                            {tSheet("eraseThisFact")}
                          </Button>
                        </form>
                      </>
                    ) : null}
                  </ConfirmDialog>

                  <ConfirmDialog
                    open={input === "taken"}
                    title={tSheet("recordTheTakeTitle")}
                    onCancel={() => setInput(null)}
                  >
                    <form action={advance} className="sheet__entry-input">
                      <input type="hidden" name="id" value={target.id} />
                      <input type="hidden" name="to" value="taken" />
                      <label className="sheet__field">
                        <Badge>{tSheet("amountActuallySigned")}</Badge>
                        {/* The field starts EMPTY: the spoils are what is in
                            play, the take is what was banked. Prefilling with
                            the estimate would report revenue nobody signed. */}
                        <input
                          name="amount"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="3 500"
                          className="sheet__input tnum"
                          required
                          ref={(node) => {
                            node?.focus({ preventScroll: true });
                          }}
                        />
                        <span className="t-body-s tone-3">
                          {offGrid
                            ? tSheet("offGridNoReference")
                            : tSheet("gridAnnounced", {
                                amount: formatEuros(price.priceCents, { decimals: "never" }),
                              })}
                        </span>
                      </label>
                      <label className="sheet__field">
                        <Badge>{tSheet("whatWasSaid")}</Badge>
                        <textarea
                          name="note"
                          rows={2}
                          className="sheet__input"
                          placeholder="Signed after Tuesday’s visit."
                        />
                      </label>
                      <div className="sheet__actions">
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={inProgress}
                          onClick={() => setInput(null)}
                        >
                          {tSheet("cancel")}
                        </Button>
                        <Button type="submit" variant="primary" disabled={inProgress}>
                          {advancePending && <Spinner />}
                          {tSheet("recordTheTake")}
                        </Button>
                      </div>
                    </form>
                  </ConfirmDialog>

                  {input === "withdrawn" ? (
                    <form action={advance} className="sheet__entry-input panel">
                      <input type="hidden" name="id" value={target.id} />
                      <input type="hidden" name="to" value="withdrawn" />
                      <label className="sheet__field">
                        <Badge>{tSheet("theReasonVerbatim")}</Badge>
                        <textarea
                          name="note"
                          rows={2}
                          className="sheet__input"
                          placeholder="Redesigned four months ago."
                          required
                        />
                        <span className="t-body-s tone-3">{tSheet("withdrawalNote")}</span>
                      </label>
                      <Button type="submit" variant="secondary" disabled={inProgress}>
                        {tSheet("recordTheWithdrawal")}
                      </Button>
                    </form>
                  ) : null}
                </>
              )}
            </section>

            <section className="sheet__section">
              <div className="sheet__section-head">
                <Badge asChild><h3>{tSheet("neighboursWithin300m")}</h3></Badge>
                {/* The businesses come from the survey, the distance is computed. */}
                <Sources keys={["sirene", "computed"]} />
              </div>
              {neighbours.length === 0 ? (
                <p className="t-body-s tone-2">{tSheet("noNeighbours")}</p>
              ) : (
                <ul className="sheet__neighbours">
                  {neighbours.map((neighbour) => (
                    <li key={neighbour.id}>
                      <button
                        type="button"
                        className="sheet__neighbour"
                        data-state={neighbour.state}
                        onClick={() => onSelect(neighbour.id)}
                      >
                        <span className="t-body sheet__neighbour-name">{neighbour.name}</span>
                        <span className="t-body-s tone-2 tnum">
                          {distance(neighbour.distanceMeters)} ·{" "}
                          {formatEuros(neighbour.expectancyCents, { decimals: "never" })}
                          {neighbour.state === "spotted"
                            ? ""
                            : ` · ${STATE_LABEL[neighbour.state]}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* `sheetAsMarkdown` owns the data rules: no personal contact
                details, no stale Google fact, calibration stated. Nothing is
                composed here. */}
            <div className="sheet__tools">
              <Button
                variant="quiet"
                size="compact"
                className="sheet__copy"
                onClick={() => {
                  void copyAsPrompt();
                }}
              >
                {copied === "fact" ? tSheet("copiedCheckmark") : tSheet("copyAsPrompt")}
              </Button>
            </div>

            {copied === "fact" ? (
              <p className="t-body-s tone-2" role="status">
                {tSheet("markdownOnClipboard")}
              </p>
            ) : null}

            {copied === "manual" ? (
              <div className="sheet__entry-input panel">
                <Badge asChild><p>{tSheet("clipboardRefused")}</p></Badge>
                <p className="t-body-s tone-2">{tSheet("clipboardRefusedBody")}</p>
                <textarea
                  className="sheet__input t-mono"
                  rows={8}
                  readOnly
                  value={sheetAsMarkdown(detail, outcomeCount)}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button variant="quiet" size="compact" onClick={() => setCopied("idle")}>
                  {tSheet("close")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "facts" ? (
          <div
            role="tabpanel"
            id="sheet-panel-facts"
            aria-labelledby="sheet-tab-facts"
            className="sheet__panel"
          >
            <section className="sheet__section">
              <div className="sheet__section-head">
                <Badge asChild><h3>{tSheet("theFiveFacts")}</h3></Badge>
                {enrichButton}
              </div>
              <div className="sheet__facts panel">
                {facts.map((fact, index) => (
                  <div key={fact.key} data-fact={fact.key}>
                    <Fact
                      name={fact.name}
                      value={fact.value}
                      verbatim={fact.verbatim}
                      sources={fact.sources}
                      surveyedOn={
                        fact.surveyedOn ? tSheet("recordedOn", { date: fact.surveyedOn }) : null
                      }
                      stale={fact.stale}
                      delayIndex={index}
                    />
                    {fact.note ? (
                      <p className="t-body-s sheet__fact-note">{fact.note}</p>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="t-body-s tone-3">{tSheet("statisticNote")}</p>
              {target.googleStale ? (
                <p className="t-body-s sheet__stale">{tSheet("googleFactsPurgedRefresh")}</p>
              ) : null}
            </section>

            <section className="sheet__section">
              <Badge asChild><h3>{tSheet("theRecord")}</h3></Badge>
              <div className="panel sheet__fields">
                {main.map(fieldRow)}
              </div>

              {/* The tail is folded, not dropped. Native `<details>`: no React
                  state, and browser find (Cmd-F) opens it on its own. The
                  counts are in the summary. */}
              <details className="sheet__all">
                <summary className="t-body-s sheet__all-summary">
                  {tSheet("allFieldsSummary", {
                    total: counting.total,
                    filled: counting.filled,
                    empty: counting.empty,
                  })}
                </summary>
                <div className="sheet__all-body">
                  {groups.map((group) => (
                    <div key={group.key} className="sheet__group" data-group={group.key}>
                      <Badge asChild><p>{group.name}</p></Badge>
                      <div className="panel sheet__fields">
                        {group.fields.map(fieldRow)}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </section>

            {/* The factor product, scrolled to from the head figure. */}
            <section className="sheet__section" ref={calculationRef}>
              <div className="sheet__section-head">
                <Badge asChild><h3>{tSheet("whereFigureComesFrom")}</h3></Badge>
                {/* None of this was surveyed; all of it is derived. */}
                <Sources keys={["computed"]} />
              </div>
              <ul className="sheet__factors panel">
                {success.factors.map((factor, index) => (
                  <li
                    key={`${factor.label}-${index}`}
                    className="sheet__factor"
                    data-weight={
                      factor.value === 0
                        ? "zero"
                        : factor.value > 1
                          ? "high"
                          : factor.value < 1
                            ? "low"
                            : "neutral"
                    }
                  >
                    <span className="t-body">
                      {tFactor(
                        factor.key as Parameters<typeof tFactor>[0],
                        factor.params as Parameters<typeof tFactor>[1],
                      )}
                    </span>
                    <span className="t-body tnum sheet__factor-value">
                      {index === 0
                        ? formatNumber(factor.value, 3)
                        : `× ${formatNumber(factor.value, 2)}`}
                    </span>
                  </li>
                ))}
                {/* The raw product is ODDS, not resistance. Put next to a
                    resistance percentage without naming which is which it reads
                    as an error, so both rows spell out the conversion. */}
                <li className="sheet__factor sheet__factor--total">
                  <span className="t-body">
                    {tSheet("rawProductOdds", {
                      odds: formatNumber(success.rawProbability, 4),
                    })}
                  </span>
                  <span className="t-body tnum">{percent(success.percent)}</span>
                </li>
                <li className="sheet__factor">
                  <span className="t-body">
                    {tSheet("resistanceFormula", {
                      pct: success.percent,
                      band: tDifficulty(BAND_LABEL_KEY[band.key] as Parameters<typeof tDifficulty>[0]),
                    })}
                  </span>
                  <span className="t-title-3 tnum">
                    {percent(target.resistancePercent)}
                  </span>
                </li>
              </ul>
              <p className="t-body-s tone-3">{tSheet("clampedProductNote")}</p>
            </section>

            {/* A pictogram alone is a riddle: the legend carries the full name,
                what the source provides, and its address when it has one. */}
            <section className="sheet__section">
              <Badge asChild><h3>{tSheet("whereAllComesFrom")}</h3></Badge>
              <SourceLegend keys={citedSources} className="panel" />
              <p className="t-body-s tone-3">{tSheet("sourcesListedNote")}</p>
            </section>
          </div>
        ) : null}

        {tab === "log" ? (
          <div
            role="tabpanel"
            id="sheet-panel-log"
            aria-labelledby="sheet-tab-log"
            className="sheet__panel"
          >
            <section className="sheet__section">
              <div className="sheet__section-head">
                <Badge asChild><h3>{tSheet("theLog")}</h3></Badge>
                {/* The only source nobody can refresh on your behalf. */}
                <Sources keys={["log"]} />
              </div>
              {log.length === 0 ? (
                <p className="t-body-s tone-2">{tSheet("nothingSaidYetLog")}</p>
              ) : (
                <ol className="sheet__log">
                  {log.map((entry) => (
                    <li key={entry.id} className="sheet__entry">
                      <span className="t-mono sheet__entry-date">
                        {shortDate(entry.occurredAt)}
                      </span>
                      <span className="sheet__entry-body">
                        <span className="t-body">
                          {EVENT_LABEL[entry.kind]}
                          {entry.valueCents !== null
                            ? ` · ${formatEuros(entry.valueCents, { decimals: "never" })}`
                            : ""}
                        </span>
                        {entry.note ? (
                          <span className="t-body sheet__entry-note">{entry.note}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="t-body-s tone-3">{tSheet("plainTextNote")}</p>
            </section>
          </div>
        ) : null}

        {advanceState.fieldErrors.amount ? (
          <p className="t-body-s sheet__error">{advanceState.fieldErrors.amount}</p>
        ) : null}
        {noteState.fieldErrors.value ? (
          <p className="t-body-s sheet__error">{noteState.fieldErrors.value}</p>
        ) : null}
      </div>

      {stamp ? (
        <Stamp
          open
          kind={stamp.to === "taken" ? "take" : "withdrawal"}
          business={stamp.targetName}
          lootCents={stamp.valueCents}
          recurringCents={stamp.recurringCents}
          sector={
            stamp.zoneLabel !== null &&
            stamp.holdBefore !== null &&
            stamp.holdAfter !== null
              ? {
                  name: stamp.zoneLabel,
                  holdBefore: stamp.holdBefore,
                  holdAfter: stamp.holdAfter,
                }
              : null
          }
          // No invented reason: the stamp carries facts only, and the real
          // reason was just typed into the log.
          reason={null}
          onClose={() => setStamp(null)}
        />
      ) : null}
    </aside>
  );
}
