"use client";

import { useState } from "react";

import { Loot, RollingAmount, Source, Badge } from "@/components/ui";
import { formatEuros } from "@/lib/format";
import { DEFAULT_PRICE_GRID } from "@/lib/priceGrid";
import { PRICE_OFFER_LABELS, scorePlace } from "@/lib/scoring";
import type { PriceGrid, ScoringFacts } from "@/lib/types";

export type WitnessProps = {
  who: string;
  sample: ScoringFacts;
  draft: PriceGrid | null;
  saved: PriceGrid;
};

function scoreUnder(grid: PriceGrid, sample: ScoringFacts) {
  return scorePlace(sample, { outcomeCount: 0, grid: grid });
}

const euros = (cents: number) => formatEuros(cents, { decimals: "never" });

export function Witness({ who, sample, draft, saved }: WitnessProps) {
  const [open, setOpen] = useState(false);
  const [lastReadable, setLastReadable] = useState<PriceGrid>(saved);

  if (draft !== null && draft !== lastReadable) setLastReadable(draft);

  const shown = draft ?? lastReadable;
  const holdingLastReadable = draft === null;

  const current = scoreUnder(shown, sample);
  const reference = scoreUnder(saved, sample);
  const fallback = scoreUnder(DEFAULT_PRICE_GRID, sample);

  const offGrid = current.price.kind === "off-grid";
  const upkeepCents = current.price.recurringCents * shown.valueHorizonMonths;
  const delta = current.price.value12MonthsCents - reference.price.value12MonthsCents;
  const differsFromDefault =
    fallback.price.value12MonthsCents !== current.price.value12MonthsCents;

  return (
    <aside
      className="pricing__witness"
      data-open={open ? "" : undefined}
      data-stale={holdingLastReadable ? "" : undefined}
    >
      <button
        type="button"
        className="quote__toggle"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
      >
        <span className="quote__toggle-who t-body-s">{who.split(" · ")[0]}</span>
        <span className="quote__toggle-sum tnum">
          {offGrid ? (
            "Off-grid"
          ) : (
            <RollingAmount cents={current.price.value12MonthsCents} />
          )}
        </span>
        <Caret />
      </button>

      {open ? (
        <div className="quote">
          <header className="quote__head">
            <h2 className="quote__who t-title-2">{who.split(" · ")[0]}</h2>
            <Source sourceKey="computed" />
          </header>
          <p className="quote__facts t-body-s">
            {who.split(" · ").slice(1).join(" · ")}
          </p>

          {offGrid ? (
            <Loot cents={null} offGrid reason={current.price.reason} size="title" />
          ) : (
            <>
              <dl className="quote__lines">
                <div className="quote__line">
                  <dt className="t-body-s">{PRICE_OFFER_LABELS[current.price.offer]}</dt>
                  <dd className="t-body-s tnum">
                    <RollingAmount cents={current.price.priceCents} />
                  </dd>
                </div>

                <div className="quote__line" data-soft>
                  <dt className="t-body-s">
                    {`Hosting & upkeep, ${shown.valueHorizonMonths} months`}
                  </dt>
                  <dd className="t-body-s tnum">
                    <RollingAmount cents={upkeepCents} />
                  </dd>
                </div>

                {current.price.adjustments.map((item) => (
                  <div key={item.label} className="quote__line" data-soft>
                    <dt className="t-body-s">{item.label}</dt>
                    <dd className="t-body-s tnum">
                      {item.amountCents >= 0 ? "+" : "−"}
                      <RollingAmount cents={Math.abs(item.amountCents)} />
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="quote__total">
                <Badge>{`Worth over ${shown.valueHorizonMonths} months`}</Badge>
                <Loot
                  cents={current.price.value12MonthsCents}
                  rolling
                  size="title"
                  className="quote__amount"
                />
              </div>
            </>
          )}

          {holdingLastReadable ? (
            <p className="quote__foot t-body-s" role="status">
              {"Last readable grid — a field is empty or out of range."}
            </p>
          ) : (
            <p className="quote__foot t-body-s tnum">
              {delta !== 0
                ? `${delta > 0 ? "▲ +" : "▼ −"}${euros(Math.abs(delta))} vs saved`
                : "Matches the saved grid."}
              {differsFromDefault
                ? ` · default ${euros(fallback.price.value12MonthsCents)}`
                : ""}
            </p>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function Caret() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="quote__caret"
    >
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}
