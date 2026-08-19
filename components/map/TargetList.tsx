"use client";

// The business list. Two uses, one component: the side panel next to the map,
// and the fallback when `new maplibregl.Map()` throws (no WebGL 2, old driver).
// It therefore offers exactly the same gestures as the map.

import { useTranslations } from "next-intl";

import type { TargetRow } from "@/app/queries";
import { Badge, percent, resistanceBand, BAND_LABEL_KEY } from "@/components/ui";
import { formatEuros } from "@/lib/format";

import { stateLabel } from "./text";

export type TargetListProps = {
  targets: readonly TargetRow[];
  /** The business open in the sheet, so the list can mark it. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Businesses rendered at most. The remainder is announced, never hidden. */
  limit?: number;
  /** Total actually in the frame: used to say what is not shown. */
  total?: number;
  /** True if the read itself was cut at its ceiling. */
  truncated?: boolean;
  className?: string;
};

/**
 * One business row, on TWO lines.
 *
 * The side panel is about 250 px wide: on a single line the right-hand column
 * of spoils, resistance and state cut the name down to about ten characters.
 */
function Row({
  target,
  selected,
  onSelect,
  showOffGrid = true,
}: {
  target: TargetRow;
  selected: boolean;
  onSelect: (id: string) => void;
  /** False inside the "Off-grid" section, whose heading already says it. */
  showOffGrid?: boolean;
}) {
  const t = useTranslations("TargetList");
  const tLabels = useTranslations("TargetLabels");
  const tDifficulty = useTranslations("Difficulty");
  const offGrid = target.score.price.kind === "off-grid";
  const band = resistanceBand(target.resistancePercent);
  const address = [target.address, target.city].filter(Boolean).join(" · ");

  return (
    <li>
      <button
        type="button"
        className="target-row"
        data-state={target.state}
        data-selected={selected ? "yes" : "no"}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(target.id)}
      >
        <span className="target-row__top">
          <span className="t-title-3 target-row__name">{target.name}</span>
          {offGrid ? (
            showOffGrid ? (
              <span className="t-micro target-row__off-grid">{t("offGrid")}</span>
            ) : null
          ) : (
            <span className="t-body-s tnum target-row__loot">
              {formatEuros(target.score.price.value12MonthsCents, { decimals: "never" })}
            </span>
          )}
        </span>

        <span className="target-row__bottom">
          <span className="t-body-s target-row__meta">
            {[
              address,
              target.state === "spotted" ? null : stateLabel(tLabels)[target.state],
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span
            className="t-micro tnum target-row__resistance"
            data-band={band.key}
          >
            {percent(target.resistancePercent)}
            <span className="sr-only">
              {t("resistanceSuffix", { band: tDifficulty(BAND_LABEL_KEY[band.key]) })}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

export function TargetList({
  targets,
  selectedId,
  onSelect,
  limit = 120,
  total,
  truncated = false,
  className,
}: TargetListProps) {
  const t = useTranslations("TargetList");

  // Off-grid targets are pulled OUT of the sort and shown first: they have an
  // expectancy of zero by construction, so sorting would bury them at the
  // bottom, and they are often the best deals in the file.
  const offGrid = targets.filter((target) => target.score.price.kind === "off-grid");
  const inGrid = targets.filter((target) => target.score.price.kind !== "off-grid");
  const shown = inGrid.slice(0, limit);
  const rest = inGrid.length - shown.length;

  if (targets.length === 0) {
    return (
      <div className={className}>
        <p className="t-body tone-2">{t("empty")}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {offGrid.length > 0 ? (
        <section className="target-list__off-grid">
          <Badge asChild><h3>{t("offGridHeading")}</h3></Badge>
          <p className="t-body-s tone-2">{t("offGridBody")}</p>
          <ul className="target-list__ul">
            {offGrid.map((target) => (
              <Row
                key={target.id}
                target={target}
                selected={target.id === selectedId}
                onSelect={onSelect}
                showOffGrid={false}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="target-list__ul">
        {shown.map((target) => (
          <Row
            key={target.id}
            target={target}
            selected={target.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>

      {rest > 0 ? (
        <p className="t-body-s tone-3 target-list__rest tnum">
          {t("restCount", { count: rest })}
        </p>
      ) : null}

      {truncated ? (
        <p className="t-body-s target-list__cut tnum">
          {typeof total === "number"
            ? t("truncatedWithTotal", { total })
            : t("truncated")}
        </p>
      ) : null}
    </div>
  );
}
