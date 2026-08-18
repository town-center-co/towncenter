"use client";

// The sectors list. Failed surveys stay in it: a failed survey is exactly what
// you need to know in order to run it again.

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { deleteZoneAction, renameZoneAction } from "@/app/actions";
import { initialActionState } from "@/app/actionState";
import type { ZoneRow } from "@/app/queries";
import { Button, Badge, ConfirmDialog, Gauge, percent, Spinner } from "@/components/ui";
import { formatEuros } from "@/lib/format";
import type { Bbox } from "@/lib/types";

import { sameFrame } from "./frame";
import { shortDate, formatNumber } from "./text";

/** Finish one sector before opening another. */
const DISCIPLINE_THRESHOLD = 0.6;

/**
 * The sector whose survey is running, as the map knows it.
 *
 * It is not in `sectors` yet: that list comes from the server and only
 * re-renders after the first batch is written.
 */
export type SectorInProgress = {
  name: string;
  /** Last page read and estimated total. Null before the first response. */
  page: number | null;
  estimatedPages: number | null;
  read: number;
  created: number;
};

export type SectorPanelProps = {
  sectors: readonly ZoneRow[];
  currentFrame: Bbox;
  /** Recentres the map on this sector. */
  onGoTo: (bbox: Bbox, sector: ZoneRow) => void;
  /** Arms the draw mode. */
  onDraw: () => void;
  drawMode: boolean;
  /** Non-null while a survey runs. Renders a ghost card at the top. */
  inProgress: SectorInProgress | null;
  /** Fires once a delete actually lands — the caller may have its own state
   *  pointed at this sector (a survey banner, the `frame` in the URL) that
   *  this panel has no way to know about. */
  onDeleted?: (sector: ZoneRow) => void;
};

function nameOf(sector: ZoneRow, t: ReturnType<typeof useTranslations<"SectorPanel">>): string {
  if (sector.label && sector.label.trim() !== "") return sector.label;
  const day = shortDate(sector.startedAt);
  return day ? t("sectorOfDate", { date: day }) : t("unnamedSector");
}

type SectorRenameDialogProps = {
  sector: ZoneRow;
  open: boolean;
  pending: boolean;
  action: (formData: FormData) => void;
  onCancel: () => void;
  /** Keyed into the form below: React 19 clears uncontrolled fields after an
   *  action, so without this a rejected rename comes back empty instead of
   *  showing what was typed. */
  formToken: number;
};

/**
 * The label is only a label: the frame, the businesses and the hold are all
 * counted from `bbox`, so this action logs nothing and recomputes nothing.
 * An empty field clears the name, which is the only way back after a typo.
 */
function SectorRenameDialog({
  sector,
  open,
  pending,
  action,
  onCancel,
  formToken,
}: SectorRenameDialogProps) {
  const t = useTranslations("SectorPanel");
  const tDialog = useTranslations("SectorRenameDialog");
  return (
    <ConfirmDialog open={open} title={tDialog("renameTitle", { name: nameOf(sector, t) })} onCancel={onCancel}>
      <form action={action} className="sheet__entry-input" key={formToken}>
        <input type="hidden" name="id" value={sector.id} />
        <label className="sheet__field">
          <Badge>{tDialog("sectorName")}</Badge>
          <input
            name="label"
            className="sheet__input"
            defaultValue={sector.label ?? ""}
            placeholder="Centre-ville"
            maxLength={120}
            autoComplete="off"
            autoFocus
          />
          <span className="t-body-s tone-3">{tDialog("clearHint")}</span>
        </label>
        <div className="sheet__actions">
          <Button type="button" variant="quiet" disabled={pending} onClick={onCancel}>
            {tDialog("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending && <Spinner />}
            {tDialog("rename")}
          </Button>
        </div>
      </form>
    </ConfirmDialog>
  );
}

type SectorDeleteDialogProps = {
  sector: ZoneRow;
  open: boolean;
  pending: boolean;
  action: (formData: FormData) => void;
  onCancel: () => void;
};

/**
 * What deleting a sector actually costs: a target has no foreign key to a
 * zone (membership is geographic, recomputed from `bbox` on every read), so
 * the figures shown here — surveyed, captures, loot — are the same live
 * counts the card already displays, not a fresh query. The outcome itself
 * (kept open with a toast on error, closed with one on success) is reported
 * by the panel, past this dialog: see the delete-token effect below.
 */
function SectorDeleteDialog({
  sector,
  open,
  pending,
  action,
  onCancel,
}: SectorDeleteDialogProps) {
  const t = useTranslations("SectorPanel");
  const tDialog = useTranslations("SectorDeleteDialog");
  const otherApproached = sector.approached - sector.captures;

  return (
    <ConfirmDialog
      open={open}
      title={tDialog("title")}
      onCancel={onCancel}
      className="confirm-dialog__card--danger"
    >
      <p className="t-body">{tDialog("eraseNotice", { name: nameOf(sector, t) })}</p>
      {sector.surveyed > 0 ? (
        <p className="t-body-s tone-2 tnum">
          {tDialog("businessesGone", { count: sector.surveyed })}
        </p>
      ) : (
        <p className="t-body-s tone-2">{tDialog("noneRecorded")}</p>
      )}
      {sector.captures > 0 ? (
        <p className="t-body-s tone-2 tnum">
          {tDialog("amongThem", {
            count: sector.captures,
            worth:
              sector.capturedLootCents > 0
                ? tDialog("worthSuffix", {
                    amount: formatEuros(sector.capturedLootCents, { decimals: "never" }),
                  })
                : "",
          })}
        </p>
      ) : null}
      {otherApproached > 0 ? (
        <p className="t-body-s tone-2 tnum">
          {tDialog("otherApproached", { count: otherApproached })}
        </p>
      ) : null}
      <p className="t-body-s tone-3">{tDialog("cannotUndo")}</p>

      <form action={action} className="sheet__actions">
        <input type="hidden" name="id" value={sector.id} />
        <Button type="button" variant="quiet" disabled={pending} onClick={onCancel}>
          {tDialog("keep")}
        </Button>
        <Button type="submit" variant="danger" disabled={pending}>
          {pending && <Spinner />}
          {tDialog("deletePermanently")}
        </Button>
      </form>
    </ConfirmDialog>
  );
}

export function SectorPanel({
  sectors,
  currentFrame,
  onGoTo,
  onDraw,
  drawMode,
  inProgress,
  onDeleted,
}: SectorPanelProps) {
  const t = useTranslations("SectorPanel");
  const [ruleLifted, setRuleLifted] = useState(false);
  /** The id of the sector being renamed. One at a time. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The sector pending a delete confirmation. One at a time. Kept as the
   *  whole row, not just an id: by the time a delete lands, `sectors` may
   *  already have dropped it, and `onDeleted` still needs its bbox. */
  const [confirmDeleteSector, setConfirmDeleteSector] = useState<ZoneRow | null>(
    null,
  );

  const [renameState, rename, renamePending] = useActionState(
    renameZoneAction,
    initialActionState,
  );

  const [deleteState, deleteZone, deletePending] = useActionState(
    deleteZoneAction,
    initialActionState,
  );

  // Closes on the TOKEN, not on the state object: a rejected rename then a
  // corrected one would return the same `status` twice and the field would
  // never close. The message goes through a toast rather than rendering
  // inline: the dialog is a portal over the whole page, so a paragraph placed
  // beside the trigger would sit behind it, invisible, exactly like the
  // delete flow before it was fixed the same way.
  const lastToken = useRef(renameState.token);
  useEffect(() => {
    if (renameState.token === lastToken.current) return;
    lastToken.current = renameState.token;
    if (renameState.status === "success") {
      setRenaming(null);
      toast.success(renameState.message);
    } else if (renameState.status === "error" && renameState.message) {
      toast.error(renameState.message);
    }
  }, [renameState]);

  // Same TOKEN reasoning as above. A rejected delete leaves the dialog open
  // and reports through a toast, same as a success — a `sonner` toast is a
  // fixed-position portal, so it is visible regardless of dialog state or
  // where the sidebar list happens to be scrolled.
  const lastDeleteToken = useRef(deleteState.token);
  useEffect(() => {
    if (deleteState.token === lastDeleteToken.current) return;
    lastDeleteToken.current = deleteState.token;
    if (deleteState.status === "success") {
      if (confirmDeleteSector) onDeleted?.(confirmDeleteSector);
      setConfirmDeleteSector(null);
      toast.success(deleteState.message);
    } else if (deleteState.status === "error" && deleteState.message) {
      toast.error(deleteState.message);
    }
  }, [deleteState, confirmDeleteSector, onDeleted]);

  // The sector being worked: the most recently opened one that returned
  // something. That is the one the rule asks you to finish.
  const current = sectors.find((sector) => sector.surveyed > 0) ?? null;
  const approachedShare =
    current && current.surveyed > 0 ? current.approached / current.surveyed : null;
  const ruleMet = approachedShare === null || approachedShare >= DISCIPLINE_THRESHOLD;

  return (
    <div className="sectors">
      <div className="sectors__head">
        <Badge asChild><h2>{t("sectors")}</h2></Badge>
        <Button
          variant={drawMode ? "primary" : "secondary"}
          size="compact"
          onClick={onDraw}
          aria-pressed={drawMode}
        >
          {drawMode ? t("drawingArmed") : t("draw")}
        </Button>
      </div>

      {current && !ruleMet && !ruleLifted ? (
        <div className="sectors__discipline">
          <Badge asChild><p>{t("discipline")}</p></Badge>
          <p className="t-body-s">{t("ruleText")}</p>
          <p className="t-body-s tnum">
            {t("ruleProgress", {
              name: nameOf(current, t),
              approached: current.approached,
              surveyed: current.surveyed,
              pct: percent((approachedShare ?? 0) * 100),
              target: percent(DISCIPLINE_THRESHOLD * 100),
            })}
          </p>
          <Gauge
            value={(approachedShare ?? 0) / DISCIPLINE_THRESHOLD}
            tint="var(--text-1)"
            thickness="fine"
            label={t("progressLabel")}
          />
          <Button variant="quiet" size="compact" onClick={() => setRuleLifted(true)}>
            {t("liftRule")}
          </Button>
        </div>
      ) : null}

      {ruleLifted ? (
        <p className="t-body-s tone-3 sectors__cheat">{t("ruleLifted")}</p>
      ) : null}

      {sectors.length === 0 && !inProgress ? (
        <p className="t-body-s tone-2 sectors__empty">{t("emptySectors")}</p>
      ) : (
        <ul className="sectors__list">
          {inProgress ? (
            <li>
              <div className="sector sector--ghost" aria-busy="true">
                <span className="t-title-3 sector__ghost-name">{inProgress.name}</span>
                <span className="t-micro sector__running">{t("surveyRunning")}</span>

                {/* Skeleton bars instead of the figures we do not have yet.
                    They promise nothing: the real count appears below as soon
                    as the first page comes back. */}
                <span className="sector__bone" aria-hidden="true" />
                <span className="sector__bone sector__bone--short" aria-hidden="true" />

                <span className="t-body-s sector__figures tnum">
                  {inProgress.page === null
                    ? t("openingSector")
                    : inProgress.estimatedPages
                      ? t("pageOf", {
                          page: inProgress.page,
                          estimated: inProgress.estimatedPages,
                          count: inProgress.read,
                          created: inProgress.created,
                        })
                      : t("pageOnly", {
                          page: inProgress.page,
                          count: inProgress.read,
                          created: inProgress.created,
                        })}
                </span>
              </div>
            </li>
          ) : null}

          {sectors.map((sector) => {
            const here = sameFrame(sector.bbox, currentFrame);
            const hasBeenSurveyed = sector.surveyed > 0;

            return (
              <li key={sector.id}>
                {/* The card link is STRETCHED over the whole card with an
                    absolute `::after`, so anything added afterwards falls
                    underneath it and becomes visible but inert. The action
                    buttons are lifted back out by `.sector__actions` in
                    `map.css`. */}
                <div
                  className="sector"
                  data-status={sector.status}
                  data-here={here ? "yes" : "no"}
                >
                  <button
                    type="button"
                    className="t-title-3 sector__name"
                    aria-current={here ? "true" : undefined}
                    onClick={() => onGoTo(sector.bbox, sector)}
                  >
                    {nameOf(sector, t)}
                  </button>

                  {sector.status === "failed" ? (
                    <span className="t-micro sector__failure">{t("surveyInterrupted")}</span>
                  ) : null}
                  {sector.status === "running" ? (
                    <span className="t-micro sector__running">{t("surveyRunning")}</span>
                  ) : null}

                  <Gauge
                    value={sector.hold}
                    segments={5}
                    tint="var(--text-1)"
                    label={t("holdOn", { name: nameOf(sector, t) })}
                  />

                  <span className="t-body-s sector__figures tnum">
                    {hasBeenSurveyed
                      ? t("holdSummary", {
                          pct: percent(sector.hold * 100),
                          surveyed: sector.surveyed,
                          captures: sector.captures,
                        })
                      : t("notSurveyedYet")}
                  </span>

                  {sector.capturedLootCents > 0 ? (
                    <span className="t-body-s sector__captured tnum">
                      {t("takenHere", {
                        amount: formatEuros(sector.capturedLootCents, { decimals: "never" }),
                      })}
                    </span>
                  ) : null}

                  <span className="t-body-s tone-3 tnum sector__area">
                    {formatNumber(sector.areaKm2, 2)} km²
                  </span>

                  <div className="sector__actions">
                    <Button
                      variant="quiet"
                      size="compact"
                      onClick={() => setRenaming(sector.id)}
                    >
                      {t("rename")}
                    </Button>
                    <Button
                      variant="quiet"
                      size="compact"
                      className="button--quiet-danger"
                      onClick={() => setConfirmDeleteSector(sector)}
                    >
                      {t("delete")}
                    </Button>
                  </div>

                  <SectorRenameDialog
                    sector={sector}
                    open={renaming === sector.id}
                    pending={renamePending}
                    action={rename}
                    onCancel={() => setRenaming(null)}
                    formToken={renameState.token}
                  />

                  <SectorDeleteDialog
                    sector={sector}
                    open={confirmDeleteSector?.id === sector.id}
                    pending={deletePending}
                    action={deleteZone}
                    onCancel={() => setConfirmDeleteSector(null)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
