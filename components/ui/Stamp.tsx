"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

import { Button } from "./button";
import { Loot } from "./Loot";
import { percent } from "./percent";
import { cx } from "./style";

/**
 * The stamp: a take, or its counterpart the withdrawal.
 *
 * No confetti and no sound, ever — the stamp celebrates the FACT, not the
 * click, and this tool is used while on the phone with someone.
 *
 * Under reduced motion the behaviour DIFFERS rather than merely speeding up:
 * the stamp is placed without deformation and stays until clicked, so the close
 * button takes focus since nothing dismisses itself any more.
 */
export type StampProps = {
  open: boolean;
  /** ASCII keys. */
  kind: "take" | "withdrawal";
  /** The business name. Visible text. */
  business: string;
  /** INTEGER CENTS. Ignored on a withdrawal. */
  lootCents?: number | null;
  /** INTEGER CENTS per month. Ignored on a withdrawal. */
  recurringCents?: number | null;
  /** The sector and its hold, before and after. */
  sector?: { name: string; holdBefore: number; holdAfter: number } | null;
  /** On a withdrawal: why. Verbatim, never reworded. */
  reason?: string | null;
  /** How long it shows before disappearing. `0` = stays until dismissed. */
  durationMs?: number;
  onClose: () => void;
};

function motionReduced(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Stamp({
  open,
  kind,
  business,
  lootCents,
  recurringCents,
  sector = null,
  reason = null,
  durationMs = 1400,
  onClose,
}: StampProps) {
  const t = useTranslations("Stamp");
  const [mounted, setMounted] = useState(false);
  const [_reducedMotion, setReducedMotion] = useState(true);
  const closeButton = useRef<HTMLButtonElement>(null);

  // `onClose` must NOT be a dependency of the timer. Callers write
  // `onClose={() => setOpen(null)}`, a new function on every render; if the
  // timer depended on its identity, any parent render would restart the 1.4 s
  // countdown — and the map parent renders several times a second during a
  // survey, so the stamp would never close on its own. The ref keeps the
  // callback current without entering the dependency array.
  const callbackRef = useRef(onClose);
  useEffect(() => {
    callbackRef.current = onClose;
  });

  // `createPortal` needs the document, which only exists after mount.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    const reduced = motionReduced();
    setReducedMotion(reduced);

    // With no motion nothing closes by itself: the keyboard must be able to
    // reach the exit without hunting for it.
    if (reduced) closeButton.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") callbackRef.current();
    };
    document.addEventListener("keydown", onKeyDown);

    if (reduced || durationMs <= 0) {
      return () => document.removeEventListener("keydown", onKeyDown);
    }

    const timer = window.setTimeout(() => callbackRef.current(), durationMs);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, durationMs]);

  if (!open || !mounted) return null;

  const capture = kind === "take";

  const content = (
    <div
      className={cx("stamp", capture ? "stamp--capture" : "stamp--withdrawal")}
      onClick={onClose}
      // Non-modal, deliberately: something that disappears after 1.4 s must not
      // capture focus. The announcement goes through `status`, the exit through
      // the button, and the veil stays clickable.
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className="stamp__card"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="t-label stamp__kind">{capture ? t("taken") : t("withdrawn")}</p>

        <p className="t-title-1 stamp__business">{business}</p>

        {capture ? (
          <Loot
            cents={lootCents ?? null}
            recurringCents={recurringCents}
            size="display"
            reason={null}
          />
        ) : (
          <p className="t-body tone-2">
            {reason ? t("spoilsOutOfPlayWithReason", { reason }) : t("spoilsOutOfPlay")}
          </p>
        )}

        {sector ? (
          <p className="t-body-s stamp__sector tnum">
            {capture
              ? t("sectorProgress", {
                  name: sector.name,
                  before: sector.holdBefore,
                  after: percent(sector.holdAfter),
                })
              : t("sectorUnchanged", { name: sector.name, after: percent(sector.holdAfter) })}
          </p>
        ) : null}

        <Button
          ref={closeButton}
          variant="quiet"
          size="compact"
          className="stamp__close"
          onClick={onClose}
        >
          {t("close")}
        </Button>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
