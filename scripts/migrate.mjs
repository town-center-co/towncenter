// applies migrations before `next start`, and exits non-zero on failure: a
// refused deploy beats a database of uncertain schema. plain JavaScript on
// purpose, it runs outside any TypeScript build step.

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL?.trim();

if (!url) {
  console.error(
    "[migrate] DATABASE_URL is missing. Set it to your Postgres connection string.",
  );
  process.exit(1);
}

const start = Date.now();

// `sslmode=disable` is the explicit opt-out for a same-network container the
// operator already controls (the Docker Compose stack's own `db` service has
// TLS off by default) — kept in sync with lib/db/index.ts's identical check.
function sslOption(value) {
  if (value.includes("localhost")) return false;
  if (/[?&]sslmode=disable\b/.test(value)) return false;
  return "require";
}

// `max: 1` keeps the migration an ordered sequence. the client is closed
// explicitly or the process stays alive and never reaches `next start`.
const client = postgres(url, {
  max: 1,
  ssl: sslOption(url),
  onnotice: () => {},
});

try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[migrate] Database up to date in ${seconds} s`);
} catch (error) {
  console.error("[migrate] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await client.end({ timeout: 5 });
}
