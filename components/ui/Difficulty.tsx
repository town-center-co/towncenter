import { useTranslations } from "next-intl";

import { CALIBRATION_MIN_OUTCOMES } from "@/lib/types";

import { Gauge } from "./Gauge";
import { percent } from "./percent";
import { cx, type StyleVars } from "./style";

export type BandKey = "easy" | "approachable" | "solid" | "hard" | "impregnable";

export type ResistanceBand = {
  // ASCII key: it drives `data-band` in CSS. Never translated.
  key: BandKey;
  /** Visible text. */
  label: string;
  /** Upper bound, inclusive, as a whole percentage. */
  ceiling: number;
};

export const RESISTANCE_BANDS: readonly ResistanceBand[] = [
  { key: "easy", label: "Easy", ceiling: 20 },
  { key: "approachable", label: "Approachable", ceiling: 40 },
  { key: "solid", label: "Solid", ceiling: 60 },
  { key: "hard", label: "Hard", ceiling: 80 },
  { key: "impregnable", label: "Impregnable", ceiling: 100 },
];

/** The band of a WHOLE resistance percentage. */
export function resistanceBand(percent: number): ResistanceBand {
  const bounded = Math.min(100, Math.max(0, Math.round(percent)));
  return RESISTANCE_BANDS.find((band) => bounded <= band.ceiling)!;
}

/**
 * Resistance is the inverse of the odds. Use only ONE of the two per screen:
 * "62 % resistance" and "38 % odds" say the same thing and read as two metrics
 * when shown side by side.
 */
export function resistanceFromOdds(chancesRatio: number): number {
  return 1 - chancesRatio;
}

/**
 * Every percentage the system displays is rounded to a step of 5 and is a whole
 * number. Never a decimal: a probability estimated on a handful of facts has no
 * three significant digits.
 */
export function roundTo5(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.round(Math.min(100, Math.max(0, percent)) / 5) * 5;
}

const ARC_RADIUS = 90;
const ARC_LENGTH = Math.PI * ARC_RADIUS;

/**
 * A target's resistance, as a bar or as an arc.
 *
 * The calibration note stays visible below `CALIBRATION_MIN_OUTCOMES` recorded
 * outcomes, in readable ink: it is what keeps an opinion from being read as a
 * measurement. Do not hide it, do not grey it out.
 */
export type DifficultyProps = {
  /** Resistance RATIO, 0 to 1. 1 = impregnable. */
  resistance: number;
  /** Number of real outcomes known. Zero by default, so: not calibrated. */
  issues?: number;
  /** Renders "computed from 4 of 5 facts". */
  facts?: { available: number; total: number } | null;
  variant?: "bar" | "arc";
  /** Which wording to use. Only one of the two per screen. */
  wording?: "resistance" | "odds";
  /** Hides the qualifier ("Solid") when there is no room. */
  withoutQualifier?: boolean;
  className?: string;
};

// ASCII band key -> visible qualifier. Kept separate from `RESISTANCE_BANDS[].label`
// (English, used as a fallback by callers that have not yet gone through
// `useTranslations`) so this file can translate its own display without them.
export const BAND_LABEL_KEY: Record<BandKey, string> = {
  easy: "easy",
  approachable: "approachable",
  solid: "solid",
  hard: "hard",
  impregnable: "impregnable",
};

export function Difficulty({
  resistance,
  issues = 0,
  facts = null,
  variant = "bar",
  wording = "resistance",
  withoutQualifier = false,
  className,
}: DifficultyProps) {
  const t = useTranslations("Difficulty");
  const ratio = Number.isFinite(resistance) ? Math.min(1, Math.max(0, resistance)) : 0;
  const resistancePct = roundTo5(ratio * 100);
  const band = resistanceBand(resistancePct);
  const qualifier = t(BAND_LABEL_KEY[band.key]);

  // Both wordings derive from the SAME rounding, so they stay complementary.
  const displayedPct = wording === "odds" ? 100 - resistancePct : resistancePct;
  const metricName = wording === "odds" ? t("metricOdds") : t("metricResistance");

  const calibrated = issues >= CALIBRATION_MIN_OUTCOMES;

  const style: StyleVars = {
    "--arc-target": ratio,
    "--arc-length": ARC_LENGTH,
  };

  const captions = (
    <>
      {facts ? (
        <p className="t-body-s difficulty__caption">
          {t("computedFrom", { available: facts.available, total: facts.total })}
        </p>
      ) : null}
      {calibrated ? null : (
        <p className="t-body-s difficulty__caption">
          {t("notCalibrated", { issues })}
        </p>
      )}
    </>
  );

  if (variant === "arc") {
    return (
      <div
        className={cx("difficulty", className)}
        data-band={band.key}
        style={style}
      >
        <div className="difficulty__arc-box">
          {/* Illustrative only: the value is written in HTML right next to it. */}
          <svg
            className="difficulty__arc"
            viewBox="0 0 200 118"
            role="presentation"
            aria-hidden="true"
            focusable="false"
          >
            <path
              className="difficulty__arc-track"
              d={`M 10 100 A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 190 100`}
            />
            <path
              className="difficulty__arc-fill"
              d={`M 10 100 A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 190 100`}
            />
            <polygon className="difficulty__arc-cursor" points="100,16 93,0 107,0" />
          </svg>

          <div className="difficulty__arc-text">
            <span className="t-display tnum difficulty__value">{percent(displayedPct)}</span>
            <span className="t-label tone-2">{metricName}</span>
            {withoutQualifier ? null : (
              <span className="t-body difficulty__qualifier">{qualifier}</span>
            )}
          </div>
        </div>
        {captions}
      </div>
    );
  }

  return (
    <div className={cx("difficulty", className)} data-band={band.key} style={style}>
      <div className="difficulty__head">
        <span className="t-title-2 tnum difficulty__value">
          {percent(displayedPct)}
          <span className="sr-only"> {metricName.toLowerCase()}</span>
        </span>
        {withoutQualifier ? null : (
          <span className="t-body-s difficulty__qualifier">{qualifier}</span>
        )}
      </div>
      {/* No `name` or `valueText`: they are already in the header above, and
          repeating them inside the bar would announce them twice. */}
      <Gauge
        value={ratio}
        tint="var(--resistance-tint)"
        thickness="epaisse"
        label={t("resistanceGaugeLabel", { pct: percent(resistancePct), qualifier })}
      />
      {captions}
    </div>
  );
}
