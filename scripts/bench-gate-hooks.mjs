// Resolution hook: `next/navigation` and `next/headers` point at the bench
// stubs. A `resolve` hook runs on its own thread and shares nothing with the
// program; it only rewrites a specifier and never runs product code.
//
// `next-intl/config` is different: outside `next build`/`next dev`,
// `next-intl` has no bundler to alias it to `i18n/request.ts` — the plugin in
// next.config.ts does that via a webpack/turbopack `resolve.alias`, which
// only exists inside Next's own bundler. Without it, `next-intl/config`
// resolves to a package-internal placeholder that unconditionally throws
// "Couldn't find next-intl config file", so `getTranslations()` — called by
// lib/harvest.ts, lib/billing/quotas.ts, app/actions.ts and app/queries.ts —
// would throw immediately in every bench. Aliasing it here to the REAL
// `i18n/request.ts` (not a stub) reproduces exactly what the webpack alias
// does, so those calls resolve a real locale from the stubbed session.

const REPLACED = new Set(["next/navigation", "next/headers"]);

export async function resolve(specifier, context, next) {
  if (specifier === "next-intl/config") {
    return {
      shortCircuit: true,
      url: new URL("../i18n/request.ts", import.meta.url).href,
    };
  }

  if (!REPLACED.has(specifier)) {
    return next(specifier, context);
  }

  return {
    shortCircuit: true,
    url: new URL("./bench-gate-stubs.mjs", import.meta.url).href,
  };
}
