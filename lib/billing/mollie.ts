// Thin Mollie v2 client over fetch: four endpoints do not justify a
// dependency. Every function throws MollieError when billing is disabled or
// Mollie refuses — callers on the webhook path catch, callers in actions let
// the action report. Amounts are whole cents until the wire, where Mollie
// wants "10.00" strings.

import "server-only";

const API = "https://api.mollie.com/v2";

export class MollieError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MollieError";
  }
}

export function mollieEnabled(): boolean {
  return Boolean(process.env.MOLLIE_API_KEY?.trim());
}

/** True when the key charges real cards: drives the "test mode" banner. */
export function mollieTestMode(): boolean {
  return Boolean(process.env.MOLLIE_API_KEY?.trim().startsWith("test_"));
}

function centsToValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function mollie<T>(
  path: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<T> {
  const key = process.env.MOLLIE_API_KEY?.trim();
  if (!key) throw new MollieError("Billing is not enabled on this instance.", 0);

  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as {
    detail?: string;
    title?: string;
  } | null;

  if (!response.ok) {
    throw new MollieError(
      payload?.detail ?? payload?.title ?? `Mollie replied ${response.status}`,
      response.status,
    );
  }

  return payload as T;
}

export type MolliePayment = {
  id: string;
  status:
    | "open"
    | "pending"
    | "authorized"
    | "paid"
    | "canceled"
    | "expired"
    | "failed";
  paidAt?: string;
  customerId?: string;
  sequenceType: "oneoff" | "first" | "recurring";
  subscriptionId?: string;
  mandateId?: string;
  metadata?: { ownerId?: string } | null;
  _links?: { checkout?: { href: string } };
};

export type MollieSubscription = {
  id: string;
  status: "pending" | "active" | "canceled" | "suspended" | "completed";
  nextPaymentDate?: string;
};

export async function createCustomer(input: {
  name: string;
  email: string;
  ownerId: string;
}): Promise<{ id: string }> {
  return mollie("/customers", {
    method: "POST",
    body: {
      name: input.name,
      email: input.email,
      metadata: { ownerId: input.ownerId },
    },
  });
}

// The only methods Mollie accepts for a €0.00 first payment; anything else
// needs at least €0.01 and would show a charge on a "free" trial signup.
export const ZERO_AMOUNT_METHODS = ["creditcard", "paypal"] as const;

export async function createFirstPayment(input: {
  customerId: string;
  ownerId: string;
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  /** Restrict the hosted checkout, e.g. to ZERO_AMOUNT_METHODS at €0.00. */
  methods?: readonly string[];
}): Promise<{ id: string; checkoutUrl: string }> {
  const payment = await mollie<MolliePayment>("/payments", {
    method: "POST",
    body: {
      amount: { currency: "EUR", value: centsToValue(input.amountCents) },
      customerId: input.customerId,
      sequenceType: "first",
      description: input.description,
      redirectUrl: input.redirectUrl,
      webhookUrl: input.webhookUrl,
      metadata: { ownerId: input.ownerId },
      ...(input.methods ? { method: [...input.methods] } : {}),
    },
  });

  const checkoutUrl = payment._links?.checkout?.href;
  if (!checkoutUrl) {
    throw new MollieError("Mollie returned no checkout URL.", 500);
  }
  return { id: payment.id, checkoutUrl };
}

export async function getPayment(id: string): Promise<MolliePayment> {
  return mollie(`/payments/${encodeURIComponent(id)}`);
}

export async function createSubscription(input: {
  customerId: string;
  ownerId: string;
  priceCents: number;
  interval: string;
  description: string;
  /** `YYYY-MM-DD`; the first month is covered by the first payment. */
  startDate: string;
  webhookUrl: string;
}): Promise<MollieSubscription> {
  return mollie(
    `/customers/${encodeURIComponent(input.customerId)}/subscriptions`,
    {
      method: "POST",
      body: {
        amount: { currency: "EUR", value: centsToValue(input.priceCents) },
        interval: input.interval,
        description: input.description,
        startDate: input.startDate,
        webhookUrl: input.webhookUrl,
        metadata: { ownerId: input.ownerId },
      },
    },
  );
}

export async function getSubscriptionAtMollie(
  customerId: string,
  subscriptionId: string,
): Promise<MollieSubscription> {
  return mollie(
    `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export async function cancelSubscriptionAtMollie(
  customerId: string,
  subscriptionId: string,
): Promise<void> {
  await mollie(
    `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" },
  );
}
