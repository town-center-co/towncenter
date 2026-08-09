// Serializable contract crossing the server/client boundary: ISO strings, never
// a `Date`. `Bbox`, `DirectorFact` and `SiteAuditFacts` are also jsonb columns.

/** Decimal degrees, WGS 84. */
export type LatLng = {
  lat: number;
  lng: number;
};

export type Bbox = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export type HarvestRequest = {
  bbox: Bbox;
  /** Drawn outline, closure implicit. Absent when the sector IS the rectangle. */
  polygon?: LatLng[];
  /** NAF 2008 codes (`56.10A`...). NAF 2025 is rejected by the API. */
  nafCodes: string[];
  label?: string | null;
  withGoogle?: boolean;
  withSiteAudit?: boolean;
};

// Natural persons only, never a statutory auditor: SIRENE mixes both into
// `dirigeants[]`. No personal contact of a director is stored.
export type DirectorFact = {
  lastName: string;
  firstNames: string | null;
  title: string;
};

export type SireneEstablishment = {
  siren: string;
  siret: string;
  name: string;
  legalName: string | null;
  naf: string | null;
  nafLabel: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  lat: number;
  lng: number;
  establishmentCount: number | null;
  companyCreatedAt: string | null;
  employeeRange: string | null;
  companyCategory: string | null;
  /** Cents. `ca: 0` from SIRENE means "accounts not filed": write `null`. */
  revenueCents: number | null;
  netIncomeCents: number | null;
  financesYear: number | null;
  directors: DirectorFact[];
};

// `googlePlaceId` is the only field storable without a time limit; the others
// expire 30 days after `fetchedAt` under Google's terms and are then purged.
export type GooglePlaceFacts = {
  googlePlaceId: string;
  /** Whole tenths: 46 for 4.6. Never a float. */
  ratingTenths: number | null;
  reviewCount: number | null;
  priceLevel: number | null;
  phone: string | null;
  websiteUrl: string | null;
  businessStatus: string | null;
  openingHours: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
    periods?: unknown[];
  } | null;
  fetchedAt: string;
};

/** Only `facts` is persisted. `confidence` and `nameScore` run 0 to 1. */
export type GooglePlaceMatch = {
  facts: GooglePlaceFacts;
  confidence: number;
  nameScore: number;
  distanceMeters: number;
  matchedName: string;
};

export type SiteAuditIssue = "site_ok" | "site_unreachable" | "no_known_site";

/** A missing key reads as "unknown"; a `false` is an observation. */
export type SiteAuditFacts = {
  issue?: SiteAuditIssue;
  url?: string | null;
  tech?: string | null;
  defaultTheme?: boolean;
  https?: boolean;
  viewport?: boolean;
  titleFilled?: boolean;
  structuredData?: boolean;
  sitemapUrlCount?: number;
  lastModified?: string | null;
  onlineSales?: boolean;
  onlineBooking?: boolean;
  agencyDetected?: boolean;
  instagramAsSite?: boolean;
  usablePhotos?: boolean;
};

/** Computed at scoring time, not harvested. */
export type ProximityFact =
  | "same-street-capture"
  | "near-live-deal"
  | "in-zone"
  | "outside-zone";

// Input of the scoring, a pure function recomputed on every read and never a
// stored column. A `null` means "unknown" and must yield a NEUTRAL factor.
export type ScoringFacts = {
  openEstablishmentCount: number | null;
  companyCreatedAt: string | null;
  /** Cents, last known fiscal year. */
  revenueCents: number | null;
  financesYear: number | null;
  employeeRange: string | null;
  companyCategory: string | null;
  ratingTenths: number | null;
  reviewCount: number | null;
  priceLevel: number | null;
  hasPhone: boolean;
  hasContactForm: boolean;
  directorCount: number;
  /** Null when the audit never ran, which is not "no website". */
  site: SiteAuditFacts | null;
  proximity: ProximityFact;
  isOpen: boolean;
  /** Opt-out right exercised: such an establishment is never stored or shown. */
  isDiffusible: boolean;
  isFranchiseGroupSite: boolean;
};

// Offers, adjustments, bounds and thresholds, all in WHOLE CENTS. One grid per
// account: `DEFAULT_PRICE_GRID`, else the `price_grids` row, via `ScoringContext`.
export type PriceGrid = {
  baseCents: number;
  fullSiteCents: number;
  multiPageCents: number;
  multiAddressCents: number;

  /** `noPhotoCents` is the only adjustment allowed to be negative. */
  perExtraAddressCents: number;
  extraAddressCapCents: number;
  bookingIntegrationCents: number;
  noPhotoCents: number;

  floorCents: number;
  ceilingCents: number;
  cappedOffers: readonly PriceOffer[];

  recurringBaseCents: number;
  recurringPerExtraAddressCents: number;
  recurringCapCents: number;
  valueHorizonMonths: number;

  maxAddressesInGrid: number;
  complexSiteMinPages: number;
  fewReviewsForBase: number;
};

export type ScoringContext = {
  outcomeCount: number;
  /** The account's grid. Absent is the normal case: `DEFAULT_PRICE_GRID`. */
  grid?: PriceGrid;
  /** Reference date, ISO. Absent: the system clock. Keeps the scoring pure. */
  now?: string;
  baseProbability?: number;
};

/** ASCII keys. `to-qualify` and `by-quote` are OFF-GRID: no price is computed. */
export type PriceOffer =
  | "base"
  | "full-site"
  | "multi-page"
  | "multi-address"
  | "to-qualify"
  | "by-quote";

export type PriceAdjustment = {
  label: string;
  amountCents: number;
};

// `kind: "off-grid"` zeroes all three amounts: an off-grid target is not a
// 0 EUR target, so read `kind` BEFORE the amounts and show `reason` instead.
export type PriceEstimate = {
  kind: "grid" | "off-grid";
  offer: PriceOffer;
  priceCents: number;
  /** Whole cents per month. */
  recurringCents: number;
  /** `priceCents + valueHorizonMonths * recurringCents`. */
  value12MonthsCents: number;
  reason: string;
  adjustments: PriceAdjustment[];
};

export type SuccessFactor = {
  label: string;
  value: number;
};

export type SuccessEstimate = {
  /** What is DISPLAYED, clamped between 0.02 and 0.85. */
  probability: number;
  /** The product before clamping. SORT ON THIS ONE: the floor collapses leads. */
  rawProbability: number;
  /** Whole percentage, rounded to 5. Never a decimal. */
  percent: number;
  factors: SuccessFactor[];
  /** False below `CALIBRATION_MIN_OUTCOMES`; the display must annotate it. */
  calibrated: boolean;
  n: number;
};

export type PlaceScore = {
  price: PriceEstimate;
  success: SuccessEstimate;
  /** `success.rawProbability * price.value12MonthsCents`, whole cents. */
  expectancyCents: number;
};

/** Google's terms of service, not a performance setting: do not extend it. */
export const GOOGLE_FRESHNESS_DAYS = 30;

export const CALIBRATION_MIN_OUTCOMES = 30;

// The enumerations live here, not in `lib/db/schema.ts` which re-exports them:
// that module drags drizzle and the driver into a client bundle. These are keys;
// changing one breaks rows already written.

// A `text` column sorts ALPHABETICALLY: order by progress through
// `TARGET_STATE_RANK` or a `CASE`, never through `order by state`.
export const TARGET_STATES = [
  "spotted",
  "studied",
  "engaged",
  "taken",
  "withdrawn",
  "dismissed",
] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export const TARGET_STATE_RANK: Record<TargetState, number> = {
  spotted: 0,
  studied: 1,
  engaged: 2,
  taken: 3,
  withdrawn: -1,
  dismissed: -2,
};

export const ZONE_STATUSES = ["running", "done", "failed"] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];

// What an account may do ON THE INSTANCE, never on the data: the role grants no
// access to another account's rows. Tenancy goes through `owner_id` alone.
export const USER_ROLES = ["owner", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Mirrors the Mollie subscription lifecycle; "pending" also covers a first
// payment whose checkout was never completed. A missing row means "none".
export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "canceled",
  "suspended",
  "completed",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const EVENT_KINDS = [
  "survey",
  "study",
  "contact",
  "reply",
  "take",
  "withdrawal",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
