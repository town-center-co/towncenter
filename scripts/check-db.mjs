// runs before `next dev` (npm's `predev` convention), so a stopped database
// fails here with one clear line instead of surfacing as a Drizzle stack
// trace from deep inside a Server Component render.

import postgres from "postgres";

const url =
  process.env.DATABASE_URL?.trim() ||
  "postgres://towncenter:towncenter@localhost:5455/towncenter";

const client = postgres(url, {
  max: 1,
  connect_timeout: 3,
  ssl: url.includes("localhost") ? false : "require",
  onnotice: () => {},
});

try {
  await client`select 1`;
} catch {
  console.error(
    "\n[check-db] Can't reach Postgres at " +
      url.replace(/:[^:@/]*@/, ":***@") +
      "\n[check-db] Start it with: docker compose up -d\n",
  );
  process.exit(1);
} finally {
  await client.end({ timeout: 1 });
}
