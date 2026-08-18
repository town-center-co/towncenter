"use client";

// Preview card anchored over a map point. Everything actionable — the five
// facts, the factor product, the approach, the neighbours, the log — lives in
// TargetSheet and is never duplicated here.

import { useTranslations } from "next-intl";

import type { TargetDetail } from "@/app/queries";
import { Button, Loot, Badge, percent, resistanceBand } from "@/components/ui";

export type FloatingSheetProps = {
  detail: TargetDetail;
  /**
   * Point position in SCREEN pixels, relative to the map container. It comes
   * from map.project(), so TerritoryMap must recompute it on every `move`:
   * without that the card stays on a stale pixel and silently labels the wrong
   * business while staying perfectly readable.
   */
  anchor: { x: number; y: number };
  /** Map container width, used to keep the card inside the frame. */
  width: number;
  onOpen: () => void;
  onClose: () => void;
};

/** Half-width of the card, and minimum margin against the container edges. */
const HALF_WIDTH = 132;
const MARGIN = 12;

export function FloatingSheet({
  detail,
  anchor,
  width,
  onOpen,
  onClose,
}: FloatingSheetProps) {
  const t = useTranslations("FloatingSheet");
  const target = detail.target;
  const offGrid = target.score.price.kind === "off-grid";
  const band = resistanceBand(target.resistancePercent);

  // Centred on the point, clamped near the edges so a business on the left rim
  // does not open a card that is half off-screen.
  const x = Math.min(
    Math.max(anchor.x, HALF_WIDTH + MARGIN),
    Math.max(HALF_WIDTH + MARGIN, width - HALF_WIDTH - MARGIN),
  );

  return (
    <div
      className="floating glass"
      style={{ left: `${x}px`, top: `${anchor.y}px` }}
      role="dialog"
      aria-label={t("previewLabel", { name: target.name })}
    >
      <button
        type="button"
        className="floating__close"
        onClick={onClose}
        aria-label={t("closePreview")}
      >
        ×
      </button>

      <p className="t-title-3 floating__name">{target.name}</p>

      {/* SIRENE already puts the town inside `address` ("12 RUE DES EXEMPLES
          75009 PARIS") and repeats it in `city`. The town is only used as a
          fallback when the address is missing. */}
      <p className="t-body-s tone-2 floating__place">
        {target.address ?? target.city ?? t("addressNotRecorded")}
      </p>

      <div className="floating__figures">
        <Loot
          cents={target.score.price.value12MonthsCents}
          recurringCents={target.score.price.recurringCents || null}
          // The twelve months are already inside the total; "+ 90 EUR/month"
          // would read as 35 % more than the figure shown.
          recurringIncluded
          size="body"
          offGrid={offGrid}
          reason={offGrid ? target.score.price.reason : null}
          label={t("spoils")}
        />

        <div className="floating__resistance">
          <Badge>{t("resistance")}</Badge>
          {/* The figure and the word, never one without the other. */}
          <span className="t-title-3 tnum floating__rate">
            {percent(target.resistancePercent)}
          </span>
          <span className="t-body-s tone-2">{band.label}</span>
        </div>
      </div>

      <Button variant="primary" size="compact" onClick={onOpen} className="floating__action">
        {t("openRecord")}
      </Button>
    </div>
  );
}
