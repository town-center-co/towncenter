// Per-account configuration. Server-only: the Google key is a secret, it is
// read here and sent to Google, and never reaches the browser in full.

import "server-only";

import { eq } from "drizzle-orm";

import { accountSettings, db } from "@/lib/db";
import { envPlacesKey } from "@/lib/sources/places";
import { openStoredSecret, sealStoredSecret } from "@/lib/storedSecret";

export type PlacesKeySource = "account" | "env" | null;

export async function getAccountPlacesKey(
  ownerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ key: accountSettings.googlePlacesKey })
    .from(accountSettings)
    .where(eq(accountSettings.ownerId, ownerId))
    .limit(1);

  return row?.key ? openStoredSecret(row.key) : null;
}

// the account's own key wins over the environment: it is the more recent, more specific choice
export async function getPlacesKey(ownerId: string): Promise<string | null> {
  return (await getAccountPlacesKey(ownerId)) ?? envPlacesKey();
}

export async function getPlacesKeySource(
  ownerId: string,
): Promise<PlacesKeySource> {
  if (await getAccountPlacesKey(ownerId)) return "account";
  if (envPlacesKey()) return "env";
  return null;
}

export async function savePlacesKey(
  ownerId: string,
  key: string,
): Promise<void> {
  const sealed = sealStoredSecret(key);
  await db
    .insert(accountSettings)
    .values({ ownerId, googlePlacesKey: sealed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: accountSettings.ownerId,
      set: { googlePlacesKey: sealed, updatedAt: new Date() },
    });
}

export async function removePlacesKey(ownerId: string): Promise<void> {
  await db
    .update(accountSettings)
    .set({ googlePlacesKey: null, updatedAt: new Date() })
    .where(eq(accountSettings.ownerId, ownerId));
}

// what the screen shows instead of the key: enough to tell two keys apart
export function maskKey(key: string): string {
  if (key.length <= 10) return "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
