"use client";

import { useEffect, useRef, useState } from "react";

import { formatEuros } from "@/lib/format";

type WitnessCounterProps = {
  cents: number;
  durationMs?: number;
  className?: string;
};

function motionReduced(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WitnessCounter({
  cents,
  durationMs = 900,
  className,
}: WitnessCounterProps) {
  const [shown, setShown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (motionReduced()) {
      setShown(cents);
      return;
    }

    let frame = 0;
    const startedAt = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(cents * eased));
      if (t < 1) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cents, durationMs]);

  return <span className={className}>{formatEuros(shown, { decimals: "never" })}</span>;
}
