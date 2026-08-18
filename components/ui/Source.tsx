"use client";

// where a displayed figure comes from. the keys are ASCII: they drive
// `data-source` and the legend order, and are never translated.

import { Popover as PopoverPrimitive } from "radix-ui";

import { cx } from "./style";

export type SourceKey = "sirene" | "google" | "audit" | "log" | "computed";

export type SourceEntry = {
  key: SourceKey;
  name: string;
  what: string;
  href: string | null;
};

export const SOURCES: Record<SourceKey, SourceEntry> = {
  sirene: {
    key: "sirene",
    name: "recherche-entreprises",
    what:
      "The public company registry (SIRENE), through recherche-entreprises.api.gouv.fr. " +
      "Free, no key, and the only source used while surveying a sector.",
    href: "https://recherche-entreprises.api.gouv.fr",
  },
  google: {
    key: "google",
    name: "Google Places",
    what:
      "Rating, reviews, phone, website address, opening hours and price level. " +
      "Fetched by enrichment only, and purged after 30 days — terms of service.",
    href: "https://developers.google.com/maps/documentation/places/web-service/overview",
  },
  audit: {
    key: "audit",
    name: "In-house site audit",
    what:
      "The storefront read directly, page by page: HTTPS, mobile viewport, title, " +
      "structured data, default theme, sitemap, photos, agency credit.",
    href: null,
  },
  log: {
    key: "log",
    name: "Your log",
    what:
      "What you recorded on the ground, dated. Never computed, never rewritten, " +
      "never retroactive.",
    href: null,
  },
  // `computed` is deliberately in the list although it is not a source: spoils
  // and resistance are derived, and left unmarked they would look measured.
  computed: {
    key: "computed",
    name: "Computed here",
    what:
      "Not a measurement: derived from the facts above by the price grid and the " +
      "scoring, and shown factor by factor so it can be checked by hand.",
    href: null,
  },
};

export const SOURCE_ORDER: readonly SourceKey[] = [
  "sirene",
  "google",
  "audit",
  "log",
  "computed",
];

// the glyphs must differ by SHAPE, not colour: the palette holds a single blue,
// so a coloured mark would pull the eye to the provenance instead of the number.
function Glyph({ sourceKey }: { sourceKey: SourceKey }) {
  const common = {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };

  switch (sourceKey) {
    case "sirene":
      return (
        <svg {...common}>
          <path d="M2.2 6.4 8 2.6l5.8 3.8" />
          <path d="M2.6 13.4h10.8" />
          <path d="M4.6 7v5.2M8 7v5.2M11.4 7v5.2" />
        </svg>
      );

    // an open "G": the bare letter borrows no trademark.
    case "google":
      return (
        <svg {...common}>
          <path d="M12.6 4.9A5.4 5.4 0 1 0 13.4 8" />
          <path d="M13.4 8H9.4" />
        </svg>
      );

    case "audit":
      return (
        <svg {...common}>
          <rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.4" />
          <path d="M2.2 6.3h11.6" />
          <path d="M4.3 4.85h.01M6.2 4.85h.01" />
        </svg>
      );

    case "log":
      return (
        <svg {...common}>
          <path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.6 13.4 3.4 10.4z" />
          <path d="M9.9 3.9l2.2 2.2" />
        </svg>
      );

    case "computed":
      return (
        <svg {...common}>
          <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.6" />
          <path d="M5 6.6h6M5 9.4h6" />
        </svg>
      );
  }
}

export type SourceProps = {
  sourceKey: SourceKey;
  withName?: boolean;
  className?: string;
};

export function Source({ sourceKey, withName = false, className }: SourceProps) {
  const source = SOURCES[sourceKey];

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cx("source", withName && "source--named", className)}
          data-source={sourceKey}
        >
          <Glyph sourceKey={sourceKey} />
          {withName ? (
            <span className="source__name t-body-s">{source.name}</span>
          ) : (
            // without the visible name the glyph is mute: the accessible
            // name of the button has to carry it.
            <span className="sr-only">{`Source: ${source.name}`}</span>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="source-popover"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <PopoverPrimitive.Close className="source-popover__close" aria-label="Close">
            ✕
          </PopoverPrimitive.Close>
          <span className="t-body-s source-popover__name">
            {source.href ? (
              <a href={source.href} target="_blank" rel="noreferrer noopener">
                {source.name}
              </a>
            ) : (
              source.name
            )}
          </span>
          <p className="t-body-s source-popover__what">{source.what}</p>
          <PopoverPrimitive.Arrow className="source-popover__arrow" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export type SourcesProps = {
  keys: readonly SourceKey[];
  className?: string;
};

export function Sources({ keys, className }: SourcesProps) {
  const kept = SOURCE_ORDER.filter((key) => keys.includes(key));
  if (kept.length === 0) return null;

  return (
    <span className={cx("sources", className)}>
      {kept.map((key) => (
        <Source key={key} sourceKey={key} />
      ))}
    </span>
  );
}

