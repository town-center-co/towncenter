import { useTranslations } from "next-intl";

import { Gauge } from "./Gauge";
import { nonBreaking } from "./percent";
import { sourceName, Sources, type SourceKey } from "./Source";
import { cx } from "./style";

/**
 * One of the named statistics that make up a target's resistance.
 *
 * A statistic with no data is NOT zero: it renders "—", says "not recorded",
 * and is excluded from the calculation. Counting an absence as a zero would
 * manufacture bad news out of nothing.
 */
export type FactProps = {
  /** Visible text. */
  name: string;
  /** 0 to 100. `null` = not recorded, therefore out of the calculation. */
  value: number | null;
  /** The raw facts, verbatim. Never reworded. */
  verbatim?: readonly string[];
  /** Where the data comes from. ASCII KEYS, never free labels. */
  sources?: readonly SourceKey[];
  /** Survey timestamp, already formatted. */
  surveyedOn?: string | null;
  /** Past 30 days a Google datum is no longer a fact. */
  stale?: boolean;
  /** Bar colour. Neutral by default. */
  tint?: string;
  /** Rank in the list: offsets the bar start by 40 ms. */
  delayIndex?: number;
  className?: string;
};

export function Fact({
  name,
  value,
  verbatim,
  sources,
  surveyedOn,
  stale = false,
  tint = "var(--text-1)",
  delayIndex = 0,
  className,
}: FactProps) {
  const t = useTranslations("Fact");
  const tSource = useTranslations("Source");
  const empty = value === null || !Number.isFinite(value);
  const bounded = empty ? 0 : Math.min(100, Math.max(0, Math.round(value)));
  const provenance = sources ?? [];
  // Names in plain text, next to the glyphs. They do not replace the legend,
  // they save a trip down to it for the row being read.
  const sourceNames = provenance.map((key) => sourceName(tSource, key)).join(" · ");

  return (
    <div className={cx("fact", empty && "fact--empty", className)}>
      <div className="fact__head">
        <span className="t-title-3 fact__name">{name}</span>
        <span className="fact__gauge">
          <Gauge
            value={empty ? 0 : bounded / 100}
            tint={tint}
            delayIndex={delayIndex}
            label={
              empty
                ? t("gaugeLabelEmpty", { name })
                : t("gaugeLabelValue", { name, value: bounded })
            }
          />
        </span>
        <span className="fact__value tnum" aria-hidden="true">
          {empty ? "—" : bounded}
        </span>
      </div>

      {empty ? (
        <p className="t-body-s fact__verbatim">{t("notRecorded")}</p>
      ) : verbatim && verbatim.length > 0 ? (
        <p className="t-body fact__verbatim">{nonBreaking(verbatim.join(" · "))}</p>
      ) : null}

      {/* The source shows even when the statistic is empty: an empty row asks
          exactly one question — who should have filled it — and the glyph is
          the answer. */}
      {provenance.length > 0 || surveyedOn ? (
        <p className="t-body-s fact__source">
          <Sources keys={provenance} />
          {nonBreaking([sourceNames, surveyedOn].filter(Boolean).join(" · "))}
          {stale ? <span className="fact__stale">{t("staleSuffix")}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
