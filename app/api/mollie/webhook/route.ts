// The one API route in the product: Mollie calls it, no session exists. The
// body carries only `id=tr_…`; authentication is fetching that id back from
// Mollie with our key. Replies 200 even on unknown ids — anything else makes
// Mollie retry for days, and a prober learns nothing from an "ok".

import { applyMolliePayment } from "@/lib/billing/subscriptions";
import { MollieError, mollieEnabled } from "@/lib/billing/mollie";

export async function POST(request: Request): Promise<Response> {
  if (!mollieEnabled()) return new Response("billing disabled", { status: 404 });

  const form = await request.formData().catch(() => null);
  const id = form?.get("id");
  if (typeof id !== "string" || id === "") {
    return new Response("missing id", { status: 400 });
  }

  if (!id.startsWith("tr_")) return new Response("ok");

  try {
    await applyMolliePayment(id);
  } catch (error) {
    if (error instanceof MollieError && error.status === 404) {
      return new Response("ok");
    }
    console.error(
      "[mollie] webhook failed:",
      error instanceof Error ? error.message : error,
    );
    // 500 asks Mollie to retry: transient database or network failures heal.
    return new Response("retry", { status: 500 });
  }

  return new Response("ok");
}
