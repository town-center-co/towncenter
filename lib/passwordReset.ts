// Password-reset tokens: creation, throttling, redemption. NEVER import this
// module from `lib/auth.ts` or `proxy.ts`, even transitively: it needs
// `node:crypto` and the database, and the proxy runs on the Edge runtime.
//
// Anti-enumeration contract: `requestPasswordReset` behaves identically for a
// known and an unknown address — same silence — and callers defer it with
// `after()` so the response time says nothing either.

import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";

import { normalizeEmail } from "@/lib/accounts";
import { db, passwordResetTokens, users } from "@/lib/db";
import { appUrl, sendEmail } from "@/lib/email/resend";
import { passwordResetEmail } from "@/lib/email/templates";
import { checkPasswordShape, hashPassword } from "@/lib/password";

export const RESET_TOKEN_TTL_MINUTES = 30;

// Cap on reset emails per address per hour. The in-memory map answers first
// and cheaply; the row count below is authoritative across restarts and
// instances, exactly like the login throttle it copies (lib/auth.ts).
const MAX_REQUESTS_PER_HOUR = 3;

// cap so a bot cannot grow process memory; the oldest entry is dropped.
const MAX_TRACKED = 5_000;

const requests = new Map<string, number[]>();

function requestAllowed(email: string): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const stamps = (requests.get(email) ?? []).filter((t) => t > cutoff);

  if (stamps.length >= MAX_REQUESTS_PER_HOUR) {
    requests.set(email, stamps);
    return false;
  }

  if (!requests.has(email) && requests.size >= MAX_TRACKED) {
    const oldest = requests.keys().next().value;
    if (oldest !== undefined) requests.delete(oldest);
  }

  stamps.push(now);
  requests.set(email, stamps);
  return true;
}

/** SHA-256, not scrypt: a 256-bit random token needs no stretching, and the
 *  lookup path must not cost 130 ms per probe. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url");
}

// Always resolves and tells the caller nothing: the form shows the same "check
// your inbox" screen whether the address exists, is throttled, or is unknown.
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (email === "") return;
  if (!requestAllowed(email)) return;

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // the empty hash is the unclaimed-sentinel account: a reset must not become
  // a way to claim it.
  if (!user || user.passwordHash === "") return;

  // opportunistic purge: this product has no cron, requests are the clock.
  await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, new Date()));

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [recent] = await db
    .select({ total: sql<number>`count(*)` })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        gt(passwordResetTokens.createdAt, oneHourAgo),
      ),
    );
  if (Number(recent?.total ?? 0) >= MAX_REQUESTS_PER_HOUR) return;

  const token = randomBytes(32).toString("base64url");
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
  });

  const resetUrl = new URL(
    `/reset-password?token=${token}`,
    appUrl(),
  ).toString();

  await sendEmail(
    user.email,
    passwordResetEmail({
      name: user.displayName,
      resetUrl,
      expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    }),
  );
}

export type ResetOutcome = { ok: true } | { ok: false; message: string };

// One generic refusal for missing, forged and expired tokens alike: telling
// them apart tells a prober which hashes exist.
const INVALID_LINK =
  "This link is invalid or has expired. Request a new one from the sign-in page.";

export async function resetPassword(
  rawToken: string,
  newPassword: string,
): Promise<ResetOutcome> {
  const token = rawToken.trim();
  if (token === "") return { ok: false, message: INVALID_LINK };

  const [row] = await db
    .select({
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      email: users.email,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(eq(passwordResetTokens.tokenHash, hashToken(token)))
    .limit(1);

  if (!row || row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, message: INVALID_LINK };
  }

  // the same rules as signup, and THESE are authoritative
  const refusal = checkPasswordShape(newPassword, normalizeEmail(row.email));
  if (refusal) return { ok: false, message: refusal.message };

  // ~130 ms of scrypt: outside the transaction, same rule as createAccount.
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  const applied = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(token)),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    if (!claimed || claimed.userId !== row.userId) return false;

    await tx
      .update(users)
      .set({
        passwordHash,
        // kills every session signed before this instant (checked in getUser)
        sessionsInvalidatedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, row.userId));

    // ALL outstanding tokens die with the used one: a second link from an
    // earlier request must not survive a completed reset.
    await tx
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, row.userId));

    return true;
  });

  return applied ? { ok: true } : { ok: false, message: INVALID_LINK };
}
