"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { Button, RollingAmount } from "@/components/ui";
import type { PriceGrid, ScoringFacts } from "@/lib/types";

import { savePriceGridAction } from "./actions";
import { centsToEuros, readGridForm, sameGrid, type GridForm } from "./form";
import { INITIAL_PRICE_GRID_STATE } from "./state";
import { Witness } from "./Witness";

type EditedField = {
  key: keyof PriceGrid;
  tab: string;
  label: string;
  when: string;
};

const FIELDS: EditedField[] = [
  {
    key: "baseCents",
    tab: "Base",
    label: "Base tier",
    when: "One address, few reviews, no usable photo — the lowest deal you would sign.",
  },
  {
    key: "fullSiteCents",
    tab: "Full site",
    label: "Full site",
    when: "One address, a site to build. The offer that sells most often, and the yardstick a target's dot size on the map is measured against.",
  },
  {
    key: "multiPageCents",
    tab: "Multi-page",
    label: "Multi-page site",
    when: "From six pages: detailed menu, forms, booking — a structure rather than a storefront.",
  },
  {
    key: "multiAddressCents",
    tab: "Multi-address",
    label: "Multi-address site",
    when: "Two to five addresses. The work changes in nature, not just in volume.",
  },
  {
    key: "recurringBaseCents",
    tab: "Monthly",
    label: "Monthly base",
    when: "Hosting, domain, backups, small fixes. Deliberately low: it keeps the relationship open, it is not where the margin is.",
  },
];

const LEAVE_AFTER_MS = 5000;

export type StepWitness = { who: string; facts: ScoringFacts };

export function PriceGridForm({
  grid,
  witnesses,
}: {
  grid: PriceGrid;
  witnesses: Record<string, StepWitness>;
}) {
  const [state, action, inProgress] = useActionState(
    savePriceGridAction,
    INITIAL_PRICE_GRID_STATE,
  );

  const [read, setRead] = useState<GridForm>({ grid: grid, fields: {} });
  const [step, setStep] = useState(0);
  const [way, setWay] = useState<"forward" | "back">("forward");
  const [smash, setSmash] = useState(0);

  const dirty = read.grid === null || !sameGrid(read.grid, grid);
  const shown = read.grid ?? grid;
  const activeField = FIELDS[step]!;
  const activeError = read.fields[activeField.key] ?? state.fields[activeField.key];
  const witness = witnesses[activeField.key]!;

  const formRef = useRef<HTMLFormElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const carryFocus = useRef(false);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [finishing, setFinishing] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => router.push("/" as Route), LEAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [finishing, router]);

  useEffect(() => {
    if (!carryFocus.current) return;
    carryFocus.current = false;
    slotRef.current
      ?.querySelector<HTMLInputElement>("label:not([data-off]) input")
      ?.select();
  }, [step]);

  const goTo = (next: number, direction?: "forward" | "back") => {
    const wrapped = (next + FIELDS.length) % FIELDS.length;
    setWay(direction ?? (wrapped > step ? "forward" : "back"));
    setStep(wrapped);
  };

  const replay = (target: HTMLElement | null | undefined, mark: string) => {
    if (!target) return;
    target.removeAttribute(`data-${mark}`);
    void target.offsetWidth;
    target.setAttribute(`data-${mark}`, "");
  };

  const onEnter = () => {
    replay(slotRef.current, "smashed");
    setSmash((count) => count + 1);

    if (step < FIELDS.length - 1) {
      carryFocus.current = true;
      goTo(step + 1, "forward");
      return;
    }

    if (dirty) formRef.current?.requestSubmit();
    setFinishing(true);
  };

  return (
    <>
      <form
        ref={formRef}
        action={action}
        className="pricing__layout"
        data-smash={smash === 0 ? undefined : smash % 2 === 0 ? "a" : "b"}
        onChange={(event) =>
          setRead(readGridForm(new FormData(event.currentTarget), grid))
        }
      >
        <div
          className="pricing__stage"
          data-way={way}
          onKeyDown={(event) => {
            if (event.target instanceof HTMLButtonElement) return;

            if (event.key === "Enter") {
              event.preventDefault();
              onEnter();
              return;
            }

            if (event.target instanceof HTMLInputElement) return;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              goTo(step - 1, "back");
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              goTo(step + 1, "forward");
            }
          }}
        >
          <div className="pricing__tabs">
            {FIELDS.map((item, index) => (
              <button
                key={item.key}
                type="button"
                className="pricing__tab"
                aria-pressed={index === step}
                onClick={() => goTo(index)}
              >
                <i className="pricing__tab-name t-micro">{item.tab}</i>
                <b className="pricing__tab-value tnum">
                  <RollingAmount cents={Math.abs(shown[item.key] as number)} />
                </b>
              </button>
            ))}
          </div>

          <p className="pricing__when t-body-s">{activeField.when}</p>

          <div className="pricing__rig">
            <button
              type="button"
              className="pricing__arrow"
              aria-label={`Previous: ${FIELDS[(step - 1 + FIELDS.length) % FIELDS.length]!.label}`}
              onClick={() => goTo(step - 1, "back")}
            >
              <Chevron />
            </button>

            <div className="pricing__slot" ref={slotRef}>
              {FIELDS.map((item, index) => (
                <label
                  key={item.key}
                  className="pricing__big"
                  data-off={index === step ? undefined : ""}
                >
                  <span className="sr-only">{item.label}</span>
                  <input
                    name={item.key}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={centsToEuros(Math.abs(grid[item.key] as number))}
                    className="pricing__big-input tnum"
                    aria-invalid={activeError && index === step ? true : undefined}
                    onInput={(event) => replay(event.currentTarget, "typing")}
                  />
                  <span className="pricing__big-unit" aria-hidden="true">
                    €
                  </span>
                </label>
              ))}
            </div>

            <button
              type="button"
              className="pricing__arrow"
              data-next
              aria-label={`Next: ${FIELDS[(step + 1) % FIELDS.length]!.label}`}
              onClick={() => goTo(step + 1, "forward")}
            >
              <Chevron />
            </button>
          </div>

          {activeError ? (
            <p className="pricing__refusal t-body-s" role="alert">
              {activeError}
            </p>
          ) : null}

          {state.error ? (
            <p className="pricing__refusal t-body-s" role="alert">
              {state.error}
            </p>
          ) : null}

          <div className="pricing__actions">
            <Button
              type="submit"
              variant="primary"
              className="pricing__save"
              disabled={inProgress || (hydrated && !dirty)}
            >
              {inProgress ? "Saving…" : "Save the grid"}
            </Button>
            {state.saved && !dirty ? (
              <p className="pricing__confirm t-body-s" role="status">
                {"Saved. The map already follows."}
              </p>
            ) : null}
          </div>
        </div>

        <Witness
          who={witness.who}
          sample={witness.facts}
          draft={read.grid}
          saved={grid}
        />

        {finishing ? (
          <div
            className="pricing__done"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pricing-done-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setFinishing(false);
            }}
          >
            <div className="pricing__done-card">
              <div className="pricing__done-timer" aria-hidden="true">
                <span className="pricing__done-bar" />
              </div>

              <div className="pricing__done-body">
                <h2 id="pricing-done-title" className="t-title-2">
                  {state.error ? "Grid not saved" : "Grid saved"}
                </h2>
                <p className="t-body-s">
                  {state.error
                    ? state.error
                    : "Every price on the map already follows it."}
                </p>

                <div className="pricing__done-act">
                  <Button
                    type="button"
                    variant="primary"
                    size="compact"
                    autoFocus
                    onClick={() => router.push("/" as Route)}
                  >
                    {"Back to the map"}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    size="compact"
                    onClick={() => setFinishing(false)}
                  >
                    {"Stay here"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </form>
    </>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}
