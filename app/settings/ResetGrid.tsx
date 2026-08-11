"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";

import { resetPriceGridAction } from "./actions";
import { INITIAL_PRICE_GRID_STATE } from "./state";

export function ResetGrid() {
  const [state, action, inProgress] = useActionState(
    resetPriceGridAction,
    INITIAL_PRICE_GRID_STATE,
  );

  return (
    <form action={action} className="pricing__reset">
      {state.error ? (
        <p className="t-body-s pricing__refusal" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="quiet" size="compact" disabled={inProgress}>
        {inProgress ? "Resetting…" : "Reset"}
      </Button>
    </form>
  );
}
