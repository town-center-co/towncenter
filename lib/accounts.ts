// Everything touching the `users` table. NEVER import this module from
// `proxy.ts`, even transitively: the proxy runs in the Edge runtime and the
// `postgres` driver opens TCP sockets. `server-only` does not catch that case.
//
// The first account created becomes the owner and CLOSES signups; `ALLOW_SIGNUPS`
// is the only way to reopen them. Until that first signup the instance is up for
// grabs, and the defence is operational: sign up right after deploying.

import "server-only";

import { redirect } from "next/navigation";
import { eq, ne, sql } from "drizzle-orm";

import { getSession } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import type { UserRole } from "@/lib/types";

// `passwordHash` is deliberately absent: this shape crosses server components,
// where one `JSON.stringify` in a prop would send the hash to the browser.
export type Account = {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
};

// Lowercase and trim, nothing more. Dots and `+` are left alone: folding
// `a.b+tag@gmail.com` to `ab@gmail.com` is wrong on every server but Gmail, and
// refuses a legitimate signup as "address already used".
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toAccount(row: {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
}): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
}

// re-read from the database, because the token proves a password was presented,
// not that the account still exists.
export async function getUser(): Promise<Account | null> {
  const session = await getSession();
  if (!session) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      passwordHash: users.passwordHash,
      sessionsInvalidatedAt: users.sessionsInvalidatedAt,
    })
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);

  if (!row) return null;
  // a row without a hash cannot sign in; same guard as in `verifyPassword`.
  if (row.passwordHash === "") return null;

  // a password reset kills every session signed before it. `iat` is whole
  // seconds, so a session created within the invalidation second survives —
  // acceptable, the reset flow issues no session of its own.
  if (
    row.sessionsInvalidatedAt &&
    session.iat < Math.floor(row.sessionsInvalidatedAt.getTime() / 1000)
  ) {
    return null;
  }

  return toAccount(row);
}

// Call on the FIRST LINE of every Server Action and at the top of every page that
// reads data. It returns the owner to pass to every read and write: isolation
// goes through `owner_id`, and the role grants nothing across accounts.
export async function requireUser(): Promise<Account> {
  const account = await getUser();
  if (!account) redirect("/login");
  return account;
}

// real accounts only: a row without a password hash can never sign in.
export async function countAccounts(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(users)
    .where(ne(users.passwordHash, ""));

  return Number(row?.total ?? 0);
}

export async function isFreshInstance(): Promise<boolean> {
  return (await countAccounts()) === 0;
}

function signupsAllowedByEnv(): boolean {
  const raw = process.env.ALLOW_SIGNUPS?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes";
}

export type SignupState = {
  open: boolean;
  isFirstAccount: boolean;
  reason: string; // visible text, empty when open
};

export async function signupState(): Promise<SignupState> {
  const isFirstAccount = await isFreshInstance();

  // the very first account always passes, or the instance stays unusable.
  if (isFirstAccount) {
    return { open: true, isFirstAccount: true, reason: "" };
  }

  if (signupsAllowedByEnv()) {
    return { open: true, isFirstAccount: false, reason: "" };
  }

  return {
    open: false,
    isFirstAccount: false,
    reason:
      "This instance is not accepting new accounts. Its owner can open them by " +
      "setting ALLOW_SIGNUPS=true.",
  };
}

export type SignupResult =
  | { ok: true; account: Account }
  | { ok: false; field: "email" | "password" | "_"; message: string };

// The driver error is WRAPPED: drizzle's message is the failed SQL, and the
// constraint name only ever appears on a `cause` further down the chain. Reading
// the top message alone turned "address already taken" into a generic refusal.
function isTakenEmail(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const node = current as {
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (node.constraint_name === "users_email_key") return true;
    if (
      typeof node.message === "string" &&
      node.message.includes("users_email_key")
    ) {
      return true;
    }
    current = node.cause;
  }
  return false;
}

// Uniqueness comes from the unique index, not from a select: two simultaneous
// signups on the same address would both pass a select. Hashing stays outside
// any transaction.
export async function createAccount(entry: {
  email: string;
  password: string;
  displayName?: string | null;
}): Promise<SignupResult> {
  const email = normalizeEmail(entry.email);

  if (email === "") {
    return { ok: false, field: "email", message: "Enter an email address." };
  }

  const state = await signupState();
  if (!state.open) {
    return { ok: false, field: "_", message: state.reason };
  }

  const hash = await hashPassword(entry.password);
  const now = new Date();
  const displayName = entry.displayName?.trim() || null;

  // two exactly simultaneous signups on a blank instance may produce two owners:
  // harmless, since the role grants no access to another account's data.
  const role: UserRole = state.isFirstAccount ? "owner" : "member";

  try {
    const [created] = await db
      .insert(users)
      .values({
        email,
        passwordHash: hash,
        displayName,
        role,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      });

    if (!created) {
      return { ok: false, field: "_", message: "Account not created. Try again." };
    }

    return { ok: true, account: toAccount(created) };
  } catch (error) {
    // the taken address is the only expected failure here; anything else propagates.
    if (isTakenEmail(error)) {
      return {
        ok: false,
        field: "email",
        message: "An account already uses this address. Sign in instead.",
      };
    }
    throw error;
  }
}

// Same refusal AND same response time for an unknown address and a wrong
// password: answering identically is not enough if a missing account returns
// before scrypt has run, so an unknown address is hashed against a decoy.
export async function verifyCredentials(
  rawEmail: string,
  password: string,
): Promise<Account | null> {
  const email = normalizeEmail(rawEmail);
  if (email === "") return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row || row.passwordHash === "") {
    await verifyPassword(password, DECOY_HASH);
    return null;
  }

  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) return null;

  // recording the sign-in must never fail the sign-in itself.
  try {
    await db
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, row.id));
  } catch (error) {
    console.error(
      "[accounts] last sign-in not recorded:",
      error instanceof Error ? error.message : error,
    );
  }

  return toAccount(row);
}

// a valid scrypt hash of a password nobody knows, never compared against a real
// input. Its parameters must stay those of `lib/password.ts` or the durations
// diverge and the timing channel reopens.
const DECOY_HASH =
  "scrypt$131072$8$1$wIX2Gu5CA6O7g2BA82Aa8g==$P0VL5g5K2ZwEFkxC2XilKSkjyb5wk7BCNLrCZgjwMiI=";
