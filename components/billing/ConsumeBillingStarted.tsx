"use client";

import { useEffect } from "react";

export function ConsumeBillingStarted() {
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("billing");
    window.history.replaceState(null, "", url);
  }, []);

  return null;
}
