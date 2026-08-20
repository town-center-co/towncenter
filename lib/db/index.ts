import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

// read at call time: at import, a missing DATABASE_URL fails the build, not the request.
function baseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url && url !== "") return url;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is missing. Point it at a Postgres database.",
    );
  }
  return "postgres://towncenter:towncenter@localhost:5455/towncenter";
}

// `sslmode=disable` is the explicit opt-out for a same-network container the
// operator already controls (the Docker Compose stack's own `db` service has
// TLS off by default) — without it, every non-localhost host is assumed to be
// a managed provider that terminates TLS. Kept in sync with the identical
// check in scripts/migrate.mjs.
function sslOption(url: string): false | "require" {
  if (url.includes("localhost")) return false;
  if (/[?&]sslmode=disable\b/.test(url)) return false;
  return "require";
}

// THE CONNECTION MUST STAY LAZY: `next build` imports this module, so a module-level
// pool opens connections against production on every deploy and never returns them.

type Connection = ReturnType<typeof drizzle<typeof schema>>;

let connection: Connection | null = null;

function open(): Connection {
  if (connection) return connection;

  const client = postgres(baseUrl(), {
    max: 10, // managed plans commonly cap at 20, and two instances overlap during a deploy
    idle_timeout: 30,
    // mandatory behind a transaction-mode pooler: prepared statements bind to a
    // connection the pooler reassigns, failing intermittently with
    // `prepared statement "s1" does not exist`.
    prepare: false,
    // `require` encrypts without demanding an authority many managed hosts lack.
    ssl: sslOption(baseUrl()),
    onnotice: () => {},
  });

  connection = drizzle(client, { schema });
  return connection;
}

export const db: Connection = new Proxy({} as Connection, {
  get(_target, property) {
    const instance = open() as unknown as Record<string | symbol, unknown>;
    const value = instance[property];
    // bind on the real instance: drizzle builders rely on `this`, not the shell.
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
export * from "./schema";
