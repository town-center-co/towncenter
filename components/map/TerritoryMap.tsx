"use client";

/*
 * The territory map: the product's main screen.
 *
 * maplibre-gl is loaded with `await import()` inside an effect, never at module
 * scope: a static import pulls an ESM-only 546 KB package into the SERVER graph
 * without breaking the build. It is pinned to 5.x — 6.x ships its worker as a
 * separate file Turbopack does not emit, and the map then renders nothing with
 * no error anywhere. Without WebGL 2 `new maplibregl.Map()` throws, hence the
 * fallback list. Tile attribution is a licence obligation: never pass
 * `attributionControl: false`, never cover it.
 */

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ellipsis } from "lucide-react";
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
} from "maplibre-gl";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { enrichZoneAction, harvestZoneAction } from "@/app/actions";
import { initialActionState } from "@/app/actionState";
import type {
  FrontLine,
  TargetCluster,
  TargetDetail,
  TargetRow,
  ZoneRow,
  ZoneStats,
} from "@/app/queries";
import {
  Button,
  Hold,
  Badge,
  Gauge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  percent,
  useTheme,
} from "@/components/ui";
import { AccountMenu } from "@/components/gate/Account";
import type { Account } from "@/lib/accounts";
import { formatEuros } from "@/lib/format";
import { areaKm2, normalizeBbox } from "@/lib/geo";
import {
  CLUSTER_RADIUS_PX,
  CLUSTER_ZOOM_MAX,
  MAP_LAYERS,
  MAX_CUMULATIVE_AREA_KM2,
  MAX_ZONE_AREA_KM2,
  PRICE_ZOOM_MIN,
  PULSE_GHOST_MS,
  PULSE_GHOST_OPACITY,
  TILES_STYLE_URL,
  TILES_STYLE_URL_FALLBACK,
} from "@/lib/limits";
import type { Bbox, LatLng } from "@/lib/types";

import { ringOf, frameContains, frameToText } from "./frame";
import { TargetToolbar } from "./TargetToolbar";
import { writeView, type TargetView } from "./view";
import {
  vertexSquare,
  stripBasemap,
  readPalette,
  hatchPattern,
  type MapPalette,
} from "./colors";
import { TargetSheet } from "./TargetSheet";
import { FloatingSheet } from "./FloatingSheet";
import { DailyFront } from "./DailyFront";
import { TargetList } from "./TargetList";
import { SectorPanel, type SectorInProgress } from "./SectorPanel";
import { formatNumber } from "./text";

// Source and image ids. ASCII keys, lowercase, dashes. LAYER ids come from
// `MAP_LAYERS`, never from here.
const SOURCE_TARGETS = "targets";
const SOURCE_CLUSTERS = "clusters";
const SOURCE_SECTORS = "sectors";
const SOURCE_DRAW = "sector-draft";
/** The sector currently being surveyed. Empty the rest of the time. */
const SOURCE_GHOST = "sector-ghost";
const IMAGE_HATCH = "sector-hatch";
const IMAGE_VERTEX = "draft-vertex";

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Past this delay the primary style is treated as unreachable. */
const STYLE_TIMEOUT_MS = 6_000;

/** Past this delay a map that has still painted nothing is declared mute. */
const PAINT_TIMEOUT_MS = 12_000;

/**
 * Picks the basemap style BEFORE the map is constructed. The fallback is
 * chosen, never switched to: `setStyle()` on a timer races, wipes every custom
 * layer, and leaves the attribution naming a style no longer in place.
 */
async function reachableStyle(): Promise<string> {
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), STYLE_TIMEOUT_MS);
  try {
    const reply = await fetch(TILES_STYLE_URL, { signal: abort.signal });
    if (reply.ok) return TILES_STYLE_URL;
  } catch {
    // Offline, timed out, CORS: the cause does not change the fallback.
  } finally {
    window.clearTimeout(timer);
  }

  console.warn("[map] OpenFreeMap unreachable, falling back to the Carto style.");
  return TILES_STYLE_URL_FALLBACK;
}

// The enrichment loop must converge, since the action excludes anything
// unqueryable from `remaining`. This ceiling exists for the day it does not.
const MAX_ENRICH_ROUNDS = 60;

const DOT_MIN_PX = 8;
const DOT_MAX_PX = 20;

// off-grid: 5+ open establishments reads as the same magnitude as a full
// standard deal — same cap the price grid itself uses for a franchise site.
const OFF_GRID_ESTABLISHMENT_CAP = 5;

// what a dot's diameter and label priority are BOTH built from: an off-grid
// target's expectancy is zero by construction, so it borrows a magnitude from
// its establishment count instead, scaled onto the same cents axis.
function lootMagnitudeCents(target: TargetRow, standardDeal: number): number {
  if (target.score.price.kind !== "off-grid") return target.score.expectancyCents;
  const ratio = Math.min(1, (target.establishmentCount ?? 0) / OFF_GRID_ESTABLISHMENT_CAP);
  return Math.round(ratio * standardDeal);
}

// area-scaled (sqrt), not linear: a target worth four times another should
// not look four times as large, or the map reads as a bar chart.
function targetDiameterPx(magnitudeCents: number, standardDeal: number): number {
  const ratio = standardDeal > 0 ? Math.min(1, Math.max(0, magnitudeCents / standardDeal)) : 0;
  return DOT_MIN_PX + (DOT_MAX_PX - DOT_MIN_PX) * Math.sqrt(ratio);
}

function targetsToGeoJSON(
  targets: readonly TargetRow[],
  selectedId: string | null,
  standardDeal: number,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: targets.map((target) => {
      const magnitude = lootMagnitudeCents(target, standardDeal);
      return {
        type: "Feature",
        id: target.id,
        geometry: { type: "Point", coordinates: [target.lng, target.lat] },
        properties: {
          id: target.id,
          name: target.name,
          // Dot DIAMETER is proportional to expected value: big dots are big
          // expectations, not decoration.
          diameter: targetDiameterPx(magnitude, standardDeal),
          state: target.state,
          offGrid: target.score.price.kind === "off-grid",
          selected: target.id === selectedId,
          // Formatted here rather than by a style expression: `formatEuros`
          // carries the fr-FR narrow no-break space between thousands, which
          // MapLibre cannot produce.
          price:
            target.score.price.kind === "off-grid"
              ? "off-grid"
              : formatEuros(target.score.price.value12MonthsCents, { decimals: "never" }),
          // Label placement priority, in cents.
          sort: magnitude,
        },
      };
    }),
  };
}

/**
 * Clusters: businesses close enough for one round. A cluster is written, not
 * drawn — the label carries the count and the spoils, and there is deliberately
 * no halo, which covered a whole block and hid the basemap.
 */
function clustersToGeoJSON(clusters: readonly TargetCluster[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: clusters.map((cluster) => ({
      type: "Feature",
      id: cluster.id,
      geometry: {
        type: "Point",
        coordinates: [cluster.center.lng, cluster.center.lat],
      },
      properties: {
        id: cluster.id,
        topTargetId: cluster.topTargetId,
        label: `${cluster.count} businesses · ${formatEuros(cluster.lootCents, { decimals: "never" })}`,
      },
    })),
  };
}

function sectorsToGeoJSON(sectors: readonly ZoneRow[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: sectors.map((sector) => ({
      type: "Feature",
      id: sector.id,
      geometry: { type: "Polygon", coordinates: [ringOf(sector.bbox)] },
      properties: {
        id: sector.id,
        // A sector drawn but not yet surveyed gets the hatched veil.
        surveyed: sector.surveyed > 0,
      },
    })),
  };
}

/**
 * The sector being surveyed. It sits on its own source rather than in
 * `SOURCE_DRAW`, which is rewritten on every `mousemove`: a second drawing
 * started during a survey would otherwise erase this ghost on the next frame.
 */
function ghostToGeoJSON(frame: Bbox): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ringOf(normalizeBbox(frame))] },
        properties: {},
      },
    ],
  };
}

/** The rectangle being drawn, with its four vertices. */
function drawToGeoJSON(start: LatLng, current: LatLng): GeoJSON.FeatureCollection {
  const frame = normalizeBbox({
    minLat: start.lat,
    maxLat: current.lat,
    minLng: start.lng,
    maxLng: current.lng,
  });
  const ring = ringOf(frame);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {},
      },
      // The ring's last point repeats the first; it is not drawn.
      ...ring.slice(0, 4).map(
        (vertex): GeoJSON.Feature => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: vertex },
          properties: {},
        }),
      ),
    ],
  };
}

/**
 * The font stack available behind the style's `glyphs`, read from the loaded
 * style rather than hardcoded: an unknown stack raises no error, the symbol
 * layer simply renders nothing. With none readable we skip the label layer.
 */
function styleFont(map: MapLibreMap): string[] | null {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol") continue;
    const stack = (layer.layout as { "text-font"?: unknown } | undefined)?.["text-font"];
    if (Array.isArray(stack) && stack.every((name) => typeof name === "string")) {
      return stack as string[];
    }
  }
  return null;
}

function installImages(map: MapLibreMap, palette: MapPalette): void {
  const hatch = hatchPattern(palette.text3);
  if (hatch) {
    if (map.hasImage(IMAGE_HATCH)) map.updateImage(IMAGE_HATCH, hatch);
    else map.addImage(IMAGE_HATCH, hatch);
  }

  const vertex = vertexSquare(palette.accentMark, palette.fond);
  if (vertex) {
    if (map.hasImage(IMAGE_VERTEX)) map.updateImage(IMAGE_VERTEX, vertex);
    else map.addImage(IMAGE_VERTEX, vertex);
  }
}

/** Geometry-type filters, written once. */
const FILTER_POLYGON: FilterSpecification = ["==", ["geometry-type"], "Polygon"];
const FILTER_POINT: FilterSpecification = ["==", ["geometry-type"], "Point"];

/*
 * `["zoom"]` may only appear at the ROOT of a `step` or `interpolate`. Nesting
 * it one level deep gets the whole expression rejected and the layer stops
 * painting, reported only as a `console.warn` — no exception, no error event.
 * Hence the radius expressions are built inside out: the zoom interpolation is
 * on the outside and the data-dependent part is repeated at each stop.
 */

/** Radius of a business dot at a given zoom factor, selection included. */
function targetRadius(factor: number): ExpressionSpecification {
  return [
    "+",
    ["*", ["/", ["get", "diameter"], 2], factor],
    ["case", ["==", ["get", "selected"], true], 5, 0],
  ];
}

// These two expressions exist so `installLayers` and `repaint` share ONE
// definition; a divergence between them only shows after a theme toggle.

/** Fill: the accent, except for what has been taken. */
function targetColor(palette: MapPalette): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "state"], "taken"],
    palette.success,
    palette.accentMark,
  ];
}

/**
 * The stroke carries the conquest state, and only that: with a single accent
 * tint it is the one coloured channel left on a dot, so selection is signalled
 * by DIAMETER instead (`targetRadius`, +5 px).
 */
function targetStroke(palette: MapPalette): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "state"], "withdrawn"],
    palette.failure,
    ["==", ["get", "selected"], true],
    palette.text1,
    // The ordinary stroke is PAPER coloured: it does not read as an outline, it
    // detaches the dot from the street underneath.
    palette.fond,
  ];
}

function installLayers(map: MapLibreMap, palette: MapPalette): void {
  installImages(map, palette);

  // The basemap is repainted layer by layer rather than veiled: a translucent
  // veil flattened the street hierarchy along with the tints.
  stripBasemap(map, palette);

  if (!map.getSource(SOURCE_SECTORS)) {
    map.addSource(SOURCE_SECTORS, { type: "geojson", data: EMPTY_COLLECTION });
  }
  if (!map.getLayer(MAP_LAYERS.sectorsFill)) {
    map.addLayer({
      id: MAP_LAYERS.sectorsFill,
      type: "fill",
      source: SOURCE_SECTORS,
      filter: ["==", ["get", "surveyed"], true],
      paint: { "fill-color": palette.accentMark, "fill-opacity": 0.06 },
    });
  }
  if (!map.getLayer(MAP_LAYERS.sectorsHatch)) {
    map.addLayer({
      id: MAP_LAYERS.sectorsHatch,
      type: "fill",
      source: SOURCE_SECTORS,
      filter: ["==", ["get", "surveyed"], false],
      paint: { "fill-pattern": IMAGE_HATCH, "fill-opacity": 0.55 },
    });
  }
  if (!map.getLayer(MAP_LAYERS.sectorsOutline)) {
    map.addLayer({
      id: MAP_LAYERS.sectorsOutline,
      type: "line",
      source: SOURCE_SECTORS,
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "surveyed"], true],
          palette.accentMark,
          palette.text3,
        ],
        "line-width": 1.5,
        "line-opacity": 0.75,
      },
    });
  }

  // The sector being surveyed: added AFTER the stored sectors and BEFORE the
  // drawing in progress, so it paints over the hatched veil it may overlap.
  if (!map.getSource(SOURCE_GHOST)) {
    map.addSource(SOURCE_GHOST, { type: "geojson", data: EMPTY_COLLECTION });
  }
  if (!map.getLayer(MAP_LAYERS.sectorGhostFill)) {
    map.addLayer({
      id: MAP_LAYERS.sectorGhostFill,
      type: "fill",
      source: SOURCE_GHOST,
      paint: {
        "fill-color": palette.accentMark,
        // Starts at the LOWER bound, not zero: with reduced motion or a
        // background tab the pulse never runs, and a zero here would make the
        // ghost invisible in exactly those cases.
        "fill-opacity": PULSE_GHOST_OPACITY.min,
      },
    });
  }
  if (!map.getLayer(MAP_LAYERS.sectorGhostLine)) {
    map.addLayer({
      id: MAP_LAYERS.sectorGhostLine,
      type: "line",
      source: SOURCE_GHOST,
      paint: {
        "line-color": palette.accentMark,
        "line-width": 2,
        "line-opacity": 0.9,
        // Dashed means "not earned yet", like the drawing in progress; a solid
        // line would read as a stored sector.
        "line-dasharray": [3, 3],
      },
    });
  }

  if (!map.getSource(SOURCE_DRAW)) {
    map.addSource(SOURCE_DRAW, { type: "geojson", data: EMPTY_COLLECTION });
  }
  if (!map.getLayer(MAP_LAYERS.sectorDraftLine)) {
    map.addLayer({
      id: MAP_LAYERS.sectorDraftLine,
      type: "line",
      source: SOURCE_DRAW,
      filter: FILTER_POLYGON,
      paint: {
        "line-color": palette.accentMark,
        "line-width": 2,
        "line-dasharray": [6, 4],
      },
    });
  }
  if (!map.getLayer(MAP_LAYERS.sectorDraftPoints)) {
    map.addLayer({
      id: MAP_LAYERS.sectorDraftPoints,
      type: "symbol",
      source: SOURCE_DRAW,
      filter: FILTER_POINT,
      layout: {
        "icon-image": IMAGE_VERTEX,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }

  if (!map.getSource(SOURCE_CLUSTERS)) {
    map.addSource(SOURCE_CLUSTERS, { type: "geojson", data: EMPTY_COLLECTION });
  }

  if (!map.getSource(SOURCE_TARGETS)) {
    map.addSource(SOURCE_TARGETS, {
      type: "geojson",
      data: EMPTY_COLLECTION,
      // Screen-space aggregation runs in MapLibre's worker on the spatial index
      // it already builds; redoing it in TypeScript would cost a recompute on
      // every `moveend` over hundreds of points.
      cluster: true,
      clusterRadius: CLUSTER_RADIUS_PX,
      clusterMaxZoom: CLUSTER_ZOOM_MAX,
    });
  }

  if (!map.getLayer(MAP_LAYERS.targetsCluster)) {
    map.addLayer({
      id: MAP_LAYERS.targetsCluster,
      type: "circle",
      source: SOURCE_TARGETS,
      filter: ["has", "point_count"],
      paint: {
        // The disc grows with the COUNT in steps: a linear area would be a blob
        // at three hundred businesses.
        "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24, 150, 30],
        "circle-color": palette.surface1,
        "circle-opacity": 0.95,
        "circle-stroke-width": 1,
        "circle-stroke-color": palette.accentMark,
      },
    });
  }

  const clusterFont = styleFont(map);
  if (clusterFont && !map.getLayer(MAP_LAYERS.targetsClusterCount)) {
    map.addLayer({
      id: MAP_LAYERS.targetsClusterCount,
      type: "symbol",
      source: SOURCE_TARGETS,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": clusterFont,
        "text-size": 13,
        // The count sits INSIDE the disc and is never moved or dropped: a bare
        // disc means nothing.
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": palette.acc },
    });
  }

  // The pins, once a cluster has broken apart.
  if (!map.getLayer(MAP_LAYERS.targetsDots)) {
    map.addLayer({
      id: MAP_LAYERS.targetsDots,
      type: "circle",
      source: SOURCE_TARGETS,
      // Everything that is not a cluster. Without this filter MapLibre paints
      // an ordinary dot UNDER each cluster disc and its stroke spills out.
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          targetRadius(0.55),
          14,
          targetRadius(1),
          18,
          targetRadius(1.3),
        ],
        "circle-color": targetColor(palette),
        // What has left play fades; the DIAMETER always stays the same, so
        // the expected value is never lost.
        "circle-opacity": [
          "match",
          ["get", "state"],
          "withdrawn",
          0.3,
          "dismissed",
          0.18,
          "taken",
          0.95,
          0.9,
        ],
        // Every ordinary dot gets the paper stroke: on a stripped basemap two
        // adjacent dots of the same tint merge into one blob when they touch,
        // and the stroke is what keeps them countable.
        "circle-stroke-width": [
          "case",
          ["==", ["get", "state"], "withdrawn"],
          1.5,
          ["==", ["get", "selected"], true],
          2.5,
          1.5,
        ],
        "circle-stroke-color": targetStroke(palette),
        "circle-stroke-opacity": 1,
      },
    });
  }

  const font = styleFont(map);

  // The amount on the pin. There is deliberately no zoom-threshold table: the
  // "prices appear as you zoom in" effect comes from the placement engine
  // (`text-allow-overlap`, `text-optional`, `symbol-sort-key`), which never
  // hides an amount where there was room.
  if (font && !map.getLayer(MAP_LAYERS.targetsPrice)) {
    map.addLayer({
      id: MAP_LAYERS.targetsPrice,
      type: "symbol",
      source: SOURCE_TARGETS,
      filter: ["!", ["has", "point_count"]],
      minzoom: PRICE_ZOOM_MIN,
      layout: {
        "text-field": ["get", "price"],
        "text-font": font,
        "text-size": 11,
        // To the right of the pin, never on it: the diameter IS information.
        "text-anchor": "left",
        "text-offset": [0.9, 0],
        "text-allow-overlap": false,
        "text-optional": true,
        // MapLibre sorts ASCENDING and the smallest key wins, so negate the
        // spoils to place the biggest first.
        "symbol-sort-key": ["-", 0, ["get", "sort"]],
      },
      paint: {
        // The amount is written in INK, not in the accent: the dot must stay
        // the only coloured object, or one business reads as two marks.
        "text-color": palette.text1,
        "text-halo-color": palette.fond,
        "text-halo-width": 1.6,
      },
    });
  }

  if (font && !map.getLayer(MAP_LAYERS.targetsLabels)) {
    map.addLayer({
      id: MAP_LAYERS.targetsLabels,
      type: "symbol",
      source: SOURCE_CLUSTERS,
      // 15, not 13: below that the cluster label sat on top of the aggregation
      // count with a different number, which reads as an error.
      minzoom: 15,
      layout: {
        "text-field": ["get", "label"],
        "text-font": font,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 1.1],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": palette.text2,
        "text-halo-color": palette.fond,
        "text-halo-width": 1.5,
      },
    });
  }
}

/** Reapplies the colours after a theme toggle. No layer is recreated. */
function repaint(map: MapLibreMap, palette: MapPalette): void {
  // Guard on OUR first layer: none of ours is installed before the sectors.
  if (!map.getLayer(MAP_LAYERS.sectorsFill)) return;

  installImages(map, palette);
  stripBasemap(map, palette);

  map.setPaintProperty(MAP_LAYERS.sectorsFill, "fill-color", palette.accentMark);
  map.setPaintProperty(MAP_LAYERS.sectorsOutline, "line-color", [
    "case",
    ["==", ["get", "surveyed"], true],
    palette.accentMark,
    palette.text3,
  ]);
  map.setPaintProperty(MAP_LAYERS.sectorGhostFill, "fill-color", palette.accentMark);
  map.setPaintProperty(MAP_LAYERS.sectorGhostLine, "line-color", palette.accentMark);
  map.setPaintProperty(MAP_LAYERS.sectorDraftLine, "line-color", palette.accentMark);

  map.setPaintProperty(MAP_LAYERS.targetsDots, "circle-color", targetColor(palette));
  map.setPaintProperty(
    MAP_LAYERS.targetsDots,
    "circle-stroke-color",
    targetStroke(palette),
  );

  if (map.getLayer(MAP_LAYERS.targetsCluster)) {
    map.setPaintProperty(MAP_LAYERS.targetsCluster, "circle-color", palette.surface1);
    map.setPaintProperty(
      MAP_LAYERS.targetsCluster,
      "circle-stroke-color",
      palette.accentMark,
    );
  }
  if (map.getLayer(MAP_LAYERS.targetsClusterCount)) {
    map.setPaintProperty(MAP_LAYERS.targetsClusterCount, "text-color", palette.acc);
  }
  if (map.getLayer(MAP_LAYERS.targetsPrice)) {
    map.setPaintProperty(MAP_LAYERS.targetsPrice, "text-color", palette.text1);
    map.setPaintProperty(MAP_LAYERS.targetsPrice, "text-halo-color", palette.fond);
  }

  if (map.getLayer(MAP_LAYERS.targetsLabels)) {
    map.setPaintProperty(MAP_LAYERS.targetsLabels, "text-color", palette.text2);
    map.setPaintProperty(MAP_LAYERS.targetsLabels, "text-halo-color", palette.fond);
  }
}

function pushData(
  map: MapLibreMap,
  source: string,
  data: GeoJSON.FeatureCollection,
): void {
  const found = map.getSource(source) as GeoJSONSource | undefined;
  // `setData` is synchronous in maplibre 5 and returns a promise in 6. We stay
  // on 5 on purpose: 6 ships its worker as `dist/maplibre-gl-worker.mjs`, which
  // Turbopack does not emit, so the map renders no tiles and no error at all.
  // The only signal is the absence of `.pbf` requests in the network tab.
  found?.setData(data);
}

export type NafOption = { code: string; label: string };

export type TerritoryMapProps = {
  /** The signed-in account. The toolbar names it and offers sign-out. */
  account: Account;
  frame: Bbox;
  frameText: string;
  /** How the businesses are ordered and which states are shown. Lives in the URL. */
  view: TargetView;
  targets: readonly TargetRow[];
  total: number;
  truncated: boolean;
  outcomeCount: number;
  clusters: readonly TargetCluster[];
  sectors: readonly ZoneRow[];
  front: readonly FrontLine[];
  stats: ZoneStats;
  /** Full-site price plus a year of hosting: the reference a dot's size is measured against. */
  standardDealCents: number;
  detail: TargetDetail | null;
  /** Cumulative area already surveyed this month. null = self-hosted, no limit. */
  cumulativeAreaKm2: { km2: number; maxKm2: number } | null;
  /** The queryable activities, with their French NAF labels. */
  naf: readonly NafOption[];
  defaultNaf: readonly string[];
  /** Records per page at `recherche-entreprises`; used to estimate progress. */
  fichesParPage: number;
};

export function TerritoryMap({
  account,
  frame,
  frameText,
  view,
  targets,
  total,
  truncated,
  outcomeCount,
  clusters,
  sectors,
  front,
  stats,
  standardDealCents,
  detail,
  cumulativeAreaKm2,
  naf,
  defaultNaf,
  fichesParPage,
}: TerritoryMapProps) {
  const router = useRouter();
  const [inTransition, beginTransition] = useTransition();

  const container = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const paletteRef = useRef<MapPalette | null>(null);

  /** Non-null means the map could not open, and says why. */
  const [fallback, setFallback] = useState<string | null>(null);
  /** The map opened but has still painted nothing. See the watchdog. */
  const [mapSilent, setMapSilent] = useState(false);
  /** Bumped on every layer install, including after a `setStyle`. */
  const [styleVersion, setStyleVersion] = useState(0);
  const [viewFrame, setViewFrame] = useState<Bbox | null>(null);
  // True once the user moved the map themselves. See `noteView`: the signal is
  // `originalEvent`, not the fact that the view changed.
  const [viewMoved, setViewMoved] = useState(false);

  const [drawMode, setDrawMode] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [drawRefusal, setDrawRefusal] = useState<string | null>(null);

  // The sector being surveyed, and its name. It outlives the drawing gesture:
  // otherwise the rectangle vanishes on mouse-up and nothing says WHERE the
  // work is happening for the minute or two a dense neighbourhood takes.
  const [sectorInProgress, setSectorInProgress] = useState<{
    frame: Bbox;
    name: string;
  } | null>(null);

  // Set when a sector is deleted while its survey banner is still showing:
  // `surveyState` is a separate action from the delete and has no idea the
  // zone it describes is gone, so this is checked by hand in `surveyRun`.
  const [dismissedSurveyZoneId, setDismissedSurveyZoneId] = useState<string | null>(
    null,
  );

  const [railTab, setRailTab] = useState<"sectors" | "businesses">("sectors");
  const [railOpen, setRailOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [chosenNaf, setChosenNaf] = useState<string[]>([...defaultNaf]);
  const [sectorName, setSectorName] = useState("");

  const { toggle: toggleTheme, description: themeDescription } = useTheme();

  const selectedId = detail?.target.id ?? null;

  // Mirror refs, read by the map's imperative event handlers.
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;

  const traceRef = useRef<{ start: LatLng; current: LatLng } | null>(null);
  const viewFrameRef = useRef<Bbox | null>(null);
  viewFrameRef.current = viewFrame;

  // The screen's state lives in the URL.
  const goTo = useCallback(
    (nextFrame: string, targetId: string | null, nextView: TargetView = view) => {
      const params = new URLSearchParams();
      params.set("frame", nextFrame);
      if (targetId) params.set("target", targetId);
      // carried on every navigation, or panning the map would silently reset the
      // sort back to expected value
      writeView(params, nextView);
      // `typedRoutes` only validates LITERAL hrefs; a built URL needs `as Route`.
      beginTransition(() => router.replace(`/?${params.toString()}` as Route, { scroll: false }));
    },
    [router, view],
  );

  // The frame and the open record are kept: changing the sort is not a move.
  const changeView = useCallback(
    (nextView: TargetView) => goTo(frameText, selectedId, nextView),
    [goTo, frameText, selectedId],
  );

  // Whether the FULL sheet is open. Selecting a business shows the floating
  // preview; the full sheet opens on demand only, and closes on every change of
  // selection.
  const [sheetOpen, setSheetOpen] = useState(false);

  const select = useCallback(
    (id: string | null) => {
      goTo(frameText, id);
      setSheetOpen(false);
      if (id) setRailOpen(false);
    },
    [goTo, frameText],
  );

  const selectRef = useRef(select);
  selectRef.current = select;

  const startSurvey = useCallback(
    (bbox: Bbox, label: string) => {
      const data = new FormData();
      data.set("frame", JSON.stringify(normalizeBbox(bbox)));
      data.set("naf", JSON.stringify(chosenNaf));
      if (label.trim() !== "") data.set("label", label.trim());
      return data;
    },
    [chosenNaf],
  );

  const [surveyState, runSurvey, surveyPending] = useActionState(
    harvestZoneAction,
    initialActionState,
  );
  const [enrichState, enrich, enrichPending] = useActionState(
    enrichZoneAction,
    initialActionState,
  );

  const surveyRef = useRef(runSurvey);
  surveyRef.current = runSurvey;
  const startSurveyRef = useRef(startSurvey);
  startSurveyRef.current = startSurvey;
  const sectorNameRef = useRef(sectorName);
  sectorNameRef.current = sectorName;

  const [surveyLoop, setSurveyLoop] = useState(false);
  const stopSurvey = useRef(false);
  const [enrichLoop, setEnrichLoop] = useState(false);
  const stopEnrich = useRef(false);
  const enrichRounds = useRef(0);

  // The badge that follows the pointer while drawing. Written straight to the
  // DOM node, never through React state: one `setState` per `mousemove` frame
  // would re-render the whole screen sixty times a second to move a label.
  const updateBadge = useCallback((bbox: Bbox | null, x: number, y: number) => {
    const node = badge.current;
    if (!node) return;

    if (!bbox) {
      node.dataset.active = "no";
      return;
    }

    const area = areaKm2(bbox);
    const tooLarge = area > MAX_ZONE_AREA_KM2;
    const overCumulative =
      cumulativeAreaKm2 !== null && area + cumulativeAreaKm2.km2 > MAX_CUMULATIVE_AREA_KM2;
    const refused = tooLarge || overCumulative;
    node.dataset.active = "yes";
    node.style.transform = `translate(${Math.round(x) + 16}px, ${Math.round(y) + 16}px)`;
    node.dataset.refusal = refused ? "yes" : "no";
    if (tooLarge) {
      node.textContent = `${formatNumber(area, 2)} km² — beyond ${MAX_ZONE_AREA_KM2} km², the survey is refused`;
    } else if (overCumulative) {
      const total = area + cumulativeAreaKm2.km2;
      node.textContent = `${formatNumber(area, 2)} km² — total would reach ${formatNumber(total, 2)} km² (${MAX_CUMULATIVE_AREA_KM2} km² limit)`;
    } else {
      node.textContent = `${formatNumber(area, 2)} km²`;
    }
  }, [cumulativeAreaKm2]);

  const cancelDraw = useCallback(() => {
    traceRef.current = null;
    setDrawing(false);
    updateBadge(null, 0, 0);
    const map = mapRef.current;
    if (map) pushData(map, SOURCE_DRAW, EMPTY_COLLECTION);
  }, [updateBadge]);

  const updateBadgeRef = useRef(updateBadge);
  updateBadgeRef.current = updateBadge;
  const cancelDrawRef = useRef(cancelDraw);
  cancelDrawRef.current = cancelDraw;

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;

    void (async () => {
      const [maplibre, style] = await Promise.all([
        import("maplibre-gl"),
        reachableStyle(),
      ]);
      if (cancelled || !container.current) return;

      const palette = readPalette();
      paletteRef.current = palette;

      const box = normalizeBbox(frame);

      try {
        map = new maplibre.Map({
          container: container.current,
          style,
          bounds: [
            [box.minLng, box.minLat],
            [box.maxLng, box.maxLat],
          ],
          fitBoundsOptions: { padding: 48 },
          // NEVER `false`: this is what satisfies the ODbL. Restyle it, never
          // remove it, and never cover it.
          attributionControl: { compact: false },
          // A field instrument: north stays up.
          pitchWithRotate: false,
          dragRotate: false,
          maxZoom: 19,
        });
      } catch (error) {
        // No WebGL 2, broken driver, refused context: say so and render the
        // list instead of a blank screen.
        setFallback(
          error instanceof Error
            ? `The map could not open: ${error.message}`
            : "The map could not open on this machine.",
        );
        return;
      }

      mapRef.current = map;
      const live = map;

      // A map that paints nothing does not throw: `new Map()` succeeds, the
      // WebGL context exists, the layers install, and no tile request ever
      // leaves. The watchdog gives the user a way out instead of a blank
      // rectangle with no explanation.
      const watchdog = window.setTimeout(() => {
        if (cancelled || live.loaded()) return;
        setMapSilent(true);
      }, PAINT_TIMEOUT_MS);
      live.once("load", () => window.clearTimeout(watchdog));

      live.on("error", (event) => {
        // A missing tile is not a failure: the map carries on, the console
        // keeps the trace.
        console.warn("[map]", event.error?.message ?? event);
      });

      // `style.load` fires on first load AND after `setStyle`. It is the only
      // place to reinstall the layers, which a style change wipes entirely.
      live.on("style.load", () => {
        if (cancelled) return;
        installLayers(live, paletteRef.current ?? palette);
        setStyleVersion((version) => version + 1);
      });

      // `originalEvent` separates a user pan from a programmatic recentre:
      // maplibre sets it for a drag, a wheel or a key, and leaves it empty for
      // `easeTo`. Without the test, "Search in this area" showed on first
      // render, because maplibre widens the requested frame to the window
      // aspect ratio and `viewOutsideFrame` is then true from the start.
      const noteView = (event?: { originalEvent?: unknown }) => {
        if (cancelled) return;
        if (event?.originalEvent) setViewMoved(true);
        const bounds = live.getBounds();
        setViewFrame({
          minLat: bounds.getSouth(),
          maxLat: bounds.getNorth(),
          minLng: bounds.getWest(),
          maxLng: bounds.getEast(),
        });
      };
      live.on("moveend", noteView);
      // Read immediately, without waiting for `load`: `bounds` is applied at
      // construction so `getBounds()` is already correct, and `load` is not
      // guaranteed to fire, which would leave the search button dead forever.
      noteView();

      live.on("click", MAP_LAYERS.targetsDots, (event) => {
        const identifier = event.features?.[0]?.properties?.id;
        if (typeof identifier === "string") selectRef.current(identifier);
      });

      // Clicking a cluster opens it: `getClusterExpansionZoom` gives the exact
      // level that breaks it apart. The call is async because the index lives
      // in the worker, and the rejection is caught: a survey finishing mid-flight
      // replaces the data and the cluster can be gone by then.
      live.on("click", MAP_LAYERS.targetsCluster, (event) => {
        const cluster = event.features?.[0];
        const identifier = cluster?.properties?.cluster_id;
        if (typeof identifier !== "number" || cluster?.geometry.type !== "Point") return;

        const source = live.getSource(SOURCE_TARGETS) as GeoJSONSource | undefined;
        const center = cluster.geometry.coordinates as [number, number];

        void source
          ?.getClusterExpansionZoom(identifier)
          .then((zoom) => {
            if (cancelled) return;
            live.easeTo({ center: center, zoom, duration: 420 });
          })
          .catch((error: unknown) => {
            console.warn("[map] cluster not found:", error);
          });
      });

      const hoveredCluster = (cursor: string) => () => {
        if (drawModeRef.current) return;
        live.getCanvas().style.cursor = cursor;
      };
      live.on("mouseenter", MAP_LAYERS.targetsCluster, hoveredCluster("pointer"));
      live.on("mouseleave", MAP_LAYERS.targetsCluster, hoveredCluster(""));

      // Clicking a cluster label opens its head: the best expected value in the
      // group, where the round would start. The label is the click target
      // because it is all the cluster draws.
      live.on("click", MAP_LAYERS.targetsLabels, (event) => {
        const head = event.features?.[0]?.properties?.topTargetId;
        if (typeof head === "string") selectRef.current(head);
      });

      const hover = (cursor: string) => () => {
        if (drawModeRef.current) return;
        live.getCanvas().style.cursor = cursor;
      };
      live.on("mouseenter", MAP_LAYERS.targetsDots, hover("pointer"));
      live.on("mouseleave", MAP_LAYERS.targetsDots, hover(""));
      live.on("mouseenter", MAP_LAYERS.targetsLabels, hover("pointer"));
      live.on("mouseleave", MAP_LAYERS.targetsLabels, hover(""));

      // Rectangle drawing, hand-rolled: no drawing library.
      const start = (point: LatLng, screen: { x: number; y: number }) => {
        if (!drawModeRef.current) return;
        traceRef.current = { start: point, current: point };
        setDrawing(true);
        pushData(live, SOURCE_DRAW, drawToGeoJSON(point, point));
        updateBadgeRef.current(
          { minLat: point.lat, maxLat: point.lat, minLng: point.lng, maxLng: point.lng },
          screen.x,
          screen.y,
        );
      };

      const next = (point: LatLng, screen: { x: number; y: number }) => {
        const draw = traceRef.current;
        if (!draw) return;
        draw.current = point;
        pushData(live, SOURCE_DRAW, drawToGeoJSON(draw.start, point));
        updateBadgeRef.current(
          normalizeBbox({
            minLat: draw.start.lat,
            maxLat: point.lat,
            minLng: draw.start.lng,
            maxLng: point.lng,
          }),
          screen.x,
          screen.y,
        );
      };

      const finish = () => {
        const draw = traceRef.current;
        if (!draw) return;

        const bbox = normalizeBbox({
          minLat: draw.start.lat,
          maxLat: draw.current.lat,
          minLng: draw.start.lng,
          maxLng: draw.current.lng,
        });

        cancelDrawRef.current();
        setDrawMode(false);

        const area = areaKm2(bbox);

        // A three-pixel rectangle is a missed click, not a sector.
        if (area < 0.0005) {
          setDrawRefusal("Rectangle too small. Drag to draw a sector.");
          return;
        }

        // Refused LOCALLY, with the measurement and the ceiling spelled out:
        // the API saturates at 10 000 results without saying so.
        if (area > MAX_ZONE_AREA_KM2) {
          setDrawRefusal(
            `Sector too large: ${formatNumber(area, 2)} km². The limit is ${MAX_ZONE_AREA_KM2} km² per sector. Cut it smaller.`,
          );
          return;
        }

        if (
          cumulativeAreaKm2 !== null &&
          area + cumulativeAreaKm2.km2 > MAX_CUMULATIVE_AREA_KM2
        ) {
          const total = area + cumulativeAreaKm2.km2;
          setDrawRefusal(
            `Cumulative limit reached: you have surveyed ${formatNumber(cumulativeAreaKm2.km2, 2)} km² this month. Adding ${formatNumber(area, 2)} km² would reach ${formatNumber(total, 2)} km² (limit: ${MAX_CUMULATIVE_AREA_KM2} km²).`,
          );
          return;
        }

        setDrawRefusal(null);
        stopSurvey.current = false;
        enrichRounds.current = 0;
        // Set BEFORE leaving: the first call can take several seconds, which is
        // exactly when the screen must already show that work has started.
        setSectorInProgress({
          frame: bbox,
          name: sectorNameRef.current.trim() || "Unnamed sector",
        });
        setSurveyLoop(true);
        startTransition(() => {
          surveyRef.current(startSurveyRef.current(bbox, sectorNameRef.current));
        });
      };

      live.on("mousedown", (event: MapMouseEvent) => {
        if (!drawModeRef.current) return;
        event.preventDefault();
        start(event.lngLat, event.point);
      });
      live.on("mousemove", (event: MapMouseEvent) => {
        next(event.lngLat, event.point);
      });
      live.on("mouseup", () => finish());

      live.on("touchstart", (event: MapTouchEvent) => {
        if (!drawModeRef.current) return;
        event.preventDefault();
        start(event.lngLat, event.point);
      });
      live.on("touchmove", (event: MapTouchEvent) => {
        if (!traceRef.current) return;
        event.preventDefault();
        next(event.lngLat, event.point);
      });
      live.on("touchend", () => finish());
    })();

    return () => {
      cancelled = true;
      mapRef.current = null;
      map?.remove();
    };
    // Mounted once: the map is an imperative object, it is not rebuilt on prop
    // changes. The initial frame is read once; later ones go through
    // `fitBounds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const palette = readPalette();
      paletteRef.current = palette;
      const map = mapRef.current;
      // Do NOT guard on `isStyleLoaded()`: it is false whenever a tile is in
      // flight, so a theme toggle during any map movement would be silently
      // lost. `repaint` checks that the layers exist, which is the right test.
      if (map) repaint(map, palette);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    pushData(map, SOURCE_TARGETS, targetsToGeoJSON(targets, selectedId, standardDealCents));
  }, [styleVersion, targets, selectedId, standardDealCents]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    pushData(map, SOURCE_CLUSTERS, clustersToGeoJSON(clusters));
  }, [styleVersion, clusters]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    pushData(map, SOURCE_SECTORS, sectorsToGeoJSON(sectors));
  }, [styleVersion, sectors]);

  // The ghost is visible for exactly as long as the loop runs. `surveyLoop`
  // alone is not enough: it drops to false between two pages while the relaunch
  // effect fires, and `surveyPending` covers that gap.
  const ghostVisible = sectorInProgress !== null && (surveyLoop || surveyPending);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    pushData(
      map,
      SOURCE_GHOST,
      ghostVisible && sectorInProgress
        ? ghostToGeoJSON(sectorInProgress.frame)
        : EMPTY_COLLECTION,
    );
  }, [styleVersion, ghostVisible, sectorInProgress]);

  // The ghost veil's pulse. MapLibre animates no paint property on its own —
  // there is no CSS transition on a WebGL layer — so `fill-opacity` is reset
  // frame by frame. The motion is decoration: under reduced motion the veil
  // sits at a fixed opacity and carries exactly the same information.
  useEffect(() => {
    if (!ghostVisible || styleVersion === 0) return;

    const map = mapRef.current;
    if (!map || !map.getLayer(MAP_LAYERS.sectorGhostFill)) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      map.setPaintProperty(
        MAP_LAYERS.sectorGhostFill,
        "fill-opacity",
        (PULSE_GHOST_OPACITY.min + PULSE_GHOST_OPACITY.max) / 2,
      );
      return;
    }

    const start = performance.now();
    let frameId = 0;

    const pulse = (now: number) => {
      // The layer can vanish under us: `setStyle` wipes everything and the
      // effect only restarts on the next `styleVersion`.
      if (!map.getLayer(MAP_LAYERS.sectorGhostFill)) return;

      // A sinusoid mapped into [0, 1] then into the two bounds. No step, no
      // jolt: this is a wait, not a blinker.
      const phase = ((now - start) % PULSE_GHOST_MS) / PULSE_GHOST_MS;
      const ripple = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
      map.setPaintProperty(
        MAP_LAYERS.sectorGhostFill,
        "fill-opacity",
        PULSE_GHOST_OPACITY.min +
          ripple * (PULSE_GHOST_OPACITY.max - PULSE_GHOST_OPACITY.min),
      );

      frameId = requestAnimationFrame(pulse);
    };

    frameId = requestAnimationFrame(pulse);

    return () => {
      cancelAnimationFrame(frameId);
      // Reset to the lower bound: the layer would otherwise keep the last
      // frame's opacity and the next ghost would start at an arbitrary value.
      if (map.getLayer(MAP_LAYERS.sectorGhostFill)) {
        map.setPaintProperty(
          MAP_LAYERS.sectorGhostFill,
          "fill-opacity",
          PULSE_GHOST_OPACITY.min,
        );
      }
    };
  }, [ghostVisible, styleVersion]);

  // Recentre when the URL frame changes.
  const lastFrame = useRef(frameText);
  useEffect(() => {
    if (lastFrame.current === frameText) return;
    lastFrame.current = frameText;

    const map = mapRef.current;
    if (!map) return;

    // After a "search in this area" the URL frame IS the current view;
    // recentring on it would jolt the map on every read.
    const view = viewFrameRef.current;
    if (view && frameToText(view) === frameText) return;

    const box = normalizeBbox(frame);
    map.fitBounds(
      [
        [box.minLng, box.minLat],
        [box.maxLng, box.maxLat],
      ],
      { padding: 48, duration: 420 },
    );
  }, [frameText, frame]);

  // Centre on the opened business.
  const lastSelectedId = useRef<string | null>(selectedId);
  useEffect(() => {
    if (lastSelectedId.current === selectedId) return;
    lastSelectedId.current = selectedId;

    const map = mapRef.current;
    if (!map || !detail) return;

    // `offset` is TRANSIENT, unlike `padding`, which would stay on the
    // transform and skew every later `fitBounds`. The large offset only applies
    // when the full sheet is open: the floating preview sits over the point and
    // needs no room cleared.
    const large = window.innerWidth >= 1000;
    map.easeTo({
      center: [detail.target.lng, detail.target.lat],
      offset: sheetOpen ? (large ? [-200, 0] : [0, -120]) : [0, 60],
      duration: 360,
    });
  }, [selectedId, detail, sheetOpen]);

  // Anchor for the floating preview. Reprojecting on every `move` is mandatory
  // and its absence is invisible: without it the card stays on a stale pixel and
  // labels the wrong business while remaining readable. `styleVersion` is a
  // dependency because a style change rebuilds the map object.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !detail || sheetOpen) {
      setAnchor(null);
      return;
    }

    const target = detail.target;
    const reproject = () => {
      const point = map.project([target.lng, target.lat]);
      setAnchor({ x: point.x, y: point.y });
    };

    reproject();
    map.on("move", reproject);
    map.on("resize", reproject);
    return () => {
      map.off("move", reproject);
      map.off("resize", reproject);
    };
  }, [detail, sheetOpen, styleVersion]);

  // Drawing mode: cursor, panning, escape.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const canvas = map.getCanvas();
    if (drawMode) {
      map.dragPan.disable();
      map.doubleClickZoom.disable();
      canvas.style.cursor = "crosshair";
    } else {
      map.dragPan.enable();
      map.doubleClickZoom.enable();
      canvas.style.cursor = "";
    }
  }, [drawMode, styleVersion]);

  useEffect(() => {
    if (!drawMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cancelDrawRef.current();
      setDrawMode(false);
      setDrawRefusal(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawMode]);

  // The long-running work loops.
  const surveyToken = useRef(surveyState.token);
  useEffect(() => {
    if (surveyState.token === surveyToken.current) return;
    surveyToken.current = surveyState.token;

    const result = surveyState.result;
    if (!result || result.kind !== "harvest") {
      setSurveyLoop(false);
      // A refusal BEFORE the first call — sector too large, unreadable frame —
      // returns no result, so the ghost has nothing to watch over.
      setSectorInProgress(null);
      return;
    }

    if (
      surveyState.status === "error" ||
      result.nextPage === null ||
      stopSurvey.current
    ) {
      setSurveyLoop(false);
      // The ghost is only lifted on a sector that really finished. A failure or
      // a stop leaves the frame in place: "Resume page N" relights it and you
      // can still see where you stopped.
      if (surveyState.status !== "error" && result.nextPage === null) {
        setSectorInProgress(null);
      }
      return;
    }

    // Server Actions are dispatched one at a time per client, so the CLIENT
    // chains the pages. `startTransition` is mandatory: called directly, the
    // action leaves `surveyPending` at `false`, the button never disables, and
    // nothing stops a second survey starting over the running one.
    const data = new FormData();
    data.set("zoneId", result.zoneId);
    data.set("page", String(result.nextPage));
    startTransition(() => runSurvey(data));
  }, [surveyState, runSurvey]);

  const enrichToken = useRef(enrichState.token);
  useEffect(() => {
    if (enrichState.token === enrichToken.current) return;
    enrichToken.current = enrichState.token;

    const result = enrichState.result;
    if (!result || result.kind !== "enrichment") {
      setEnrichLoop(false);
      return;
    }

    enrichRounds.current += 1;

    // Stop as soon as a round enriched NOTHING: the action excludes anything
    // unqueryable from `remaining`, so an empty round means something is wrong
    // and retrying would not fix it.
    const progressed = result.enriched > 0 || result.purged > 0;
    if (
      enrichState.status === "error" ||
      result.remaining <= 0 ||
      !progressed ||
      stopEnrich.current ||
      enrichRounds.current >= MAX_ENRICH_ROUNDS
    ) {
      setEnrichLoop(false);
      return;
    }

    const data = new FormData();
    data.set("frame", JSON.stringify(normalizeBbox(frame)));
    startTransition(() => enrich(data));
  }, [enrichState, enrich, frame]);

  // True only for the STALE result of the deleted zone, never for a survey
  // genuinely in flight: `surveyPending` alone still shows "Survey running"
  // for whatever runs next, even in the one-request window before its own
  // result has landed and this flag would otherwise still read the old one.
  const surveyDismissed =
    surveyState.result?.kind === "harvest" &&
    surveyState.result.zoneId === dismissedSurveyZoneId;

  const surveyRun =
    surveyState.result?.kind === "harvest" && !surveyDismissed
      ? surveyState.result
      : null;
  const enrichment =
    enrichState.result?.kind === "enrichment" ? enrichState.result : null;

  const estimatedPages =
    surveyRun && surveyRun.totalResults > 0
      ? Math.max(surveyRun.page, Math.ceil(surveyRun.totalResults / fichesParPage))
      : null;
  const surveyProgress =
    surveyRun && estimatedPages ? Math.min(1, surveyRun.page / estimatedPages) : 0;

  // Both conditions are needed and neither is sufficient: `viewMoved` alone
  // would light the button for a ten-pixel pan inside the sector, where nothing
  // is left to read, and `viewOutsideFrame` alone would light it on first
  // render, since maplibre always widens the requested frame to the window
  // aspect ratio.
  const viewOutsideFrame =
    viewMoved && viewFrame !== null && !frameContains(frame, viewFrame);

  // A new survey resets the flag: the view is the frame again.
  useEffect(() => {
    setViewMoved(false);
  }, [frameText]);

  const sectorHere =
    sectors.find((sector) => frameToText(sector.bbox) === frameText) ?? null;
  const nameHere = sectorHere?.label?.trim() || (sectorHere ? "this sector" : "this view");

  // A deleted sector leaves two things pointed at nothing: its own survey
  // banner, if still showing, and the `frame` param, if that was the view
  // being looked at. `frame` drops rather than picks a replacement — the
  // server recomputes its own default the same way it does on a bare `/`.
  const handleSectorDeleted = useCallback(
    (deleted: ZoneRow) => {
      if (surveyRun?.zoneId === deleted.id) setDismissedSurveyZoneId(deleted.id);
      if (frameToText(deleted.bbox) === frameText) {
        beginTransition(() => router.replace("/" as Route, { scroll: false }));
      }
    },
    [surveyRun, frameText, router],
  );

  const resurveyThisView = () => {
    if (!viewFrame) return;
    goTo(frameToText(viewFrame), selectedId);
  };

  const startEnrichment = () => {
    stopEnrich.current = false;
    enrichRounds.current = 0;
    setEnrichLoop(true);
    const data = new FormData();
    data.set("frame", JSON.stringify(normalizeBbox(frame)));
    startTransition(() => enrich(data));
  };

  const resumeSurvey = () => {
    if (!surveyRun || surveyRun.nextPage === null) return;
    stopSurvey.current = false;
    setSurveyLoop(true);
    const data = new FormData();
    data.set("zoneId", surveyRun.zoneId);
    data.set("page", String(surveyRun.nextPage));
    startTransition(() => runSurvey(data));
  };

  // What the sector panel shows while a survey runs. The counters come from the
  // LAST page returned, never an estimate: until one comes back `page` is
  // `null`, so the panel says the sector is opening rather than show a zero.
  const ghostSector: SectorInProgress | null =
    ghostVisible && sectorInProgress
      ? {
          name: sectorInProgress.name,
          page: surveyRun?.page ?? null,
          estimatedPages,
          read: surveyRun?.found ?? 0,
          created: surveyRun?.created ?? 0,
        }
      : null;

  const leftRail = (
    <aside className="territory__rail" data-open={railOpen ? "yes" : "no"}>
      <div className="territory__tabs" role="tablist" aria-label="Side panel">
        <button
          type="button"
          role="tab"
          aria-selected={railTab === "sectors"}
          className="territory__tab"
          onClick={() => setRailTab("sectors")}
        >
          <Badge>Sectors</Badge>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={railTab === "businesses"}
          className="territory__tab"
          onClick={() => setRailTab("businesses")}
        >
          <Badge>Businesses</Badge>
        </button>
      </div>

      <div className="territory__rail-body">
        {railTab === "sectors" ? (
          <SectorPanel
            sectors={sectors}
            currentFrame={frame}
            drawMode={drawMode}
            inProgress={ghostSector}
            onDraw={() => {
              setDrawRefusal(null);
              setDrawMode((mode) => !mode);
              setRailOpen(false);
            }}
            onGoTo={(bbox) => {
              setRailOpen(false);
              goTo(frameToText(bbox), null);
            }}
            onDeleted={handleSectorDeleted}
          />
        ) : (
          <>
            <TargetToolbar
              view={view}
              onChange={changeView}
              busy={inTransition}
            />
            <TargetList
              targets={targets}
              selectedId={selectedId}
              onSelect={select}
              total={total}
              truncated={truncated}
              className="territory__list"
            />
          </>
        )}
      </div>
    </aside>
  );

  // Read by the CSS too: the drawer overlays the corner where the tools sit.
  const recordOpen = Boolean(detail) && (sheetOpen || Boolean(fallback));

  return (
    <div className="territory__body">
      {leftRail}

      <div className="territory__stage">
        {/* The map, or its fallback. The container stays mounted either way:
            maplibre claims this node, and destroying it would block any retry.
            `data-collapsed` is also on the shell, because without a map the
            toolbar stops being an overlay and becomes a row above the list. */}
        <div
          className="map"
          data-collapsed={fallback ? "yes" : "no"}
          data-sheet={recordOpen ? "open" : "closed"}
        >
          <div
            ref={container}
            className="map__canvas"
            data-collapsed={fallback ? "yes" : "no"}
            data-drawing={drawMode ? "yes" : "no"}
            aria-label="Territory map"
            role="application"
          />

          {/* Deliberately carries no dynamic attribute: see `updateBadge`. */}
          <div ref={badge} className="map__badge t-micro tnum" aria-hidden="true" />

          {fallback ? (
            <div className="map__fallback">
              <Badge asChild><h2>No map</h2></Badge>
              <p className="t-body">
                {fallback} The territory then reads as a list, sorted by expected value —
                the gestures are exactly the same.
              </p>
              <TargetList
                targets={targets}
                selectedId={selectedId}
                onSelect={select}
                total={total}
                truncated={truncated}
              />
            </div>
          ) : null}

          {mapSilent && !fallback ? (
            <div className="map__silent panel" role="status">
              <Badge asChild><h2>The map is not painting</h2></Badge>
              <p className="t-body">
                The base map showed nothing after{" "}
                {Math.round(PAINT_TIMEOUT_MS / 1000)}
                {" seconds. "}
                This is not a territory failure: the businesses are read correctly, only
                their mapping is missing. An old graphics driver, a network blocking
                the tiles or a restricted browser is enough.
              </p>
              <div className="map__work-actions">
                <Button
                  variant="primary"
                  size="compact"
                  onClick={() =>
                    setFallback(
                      "The base map never answered on this machine.",
                    )
                  }
                >
                  Switch to the list
                </Button>
                <Button
                  variant="quiet"
                  size="compact"
                  onClick={() => setMapSilent(false)}
                >
                  Keep waiting
                </Button>
              </div>
            </div>
          ) : null}

          {/* Shown only when the view has left the surveyed frame, so the
              control is never a permanently disabled button. `|| inTransition`
              is required: without it the click sets the new frame,
              `viewOutsideFrame` flips to false and the button disappears before
              it can say "Searching…", leaving the gesture unacknowledged. */}
          {viewFrame && (viewOutsideFrame || inTransition) ? (
            <div className="map__search">
              <Button
                variant="primary"
                size="compact"
                className="tooltip tooltip--below"
                aria-label="Search in this area — read the businesses inside the current view"
                disabled={inTransition}
                onClick={resurveyThisView}
              >
                {inTransition ? "Searching…" : "Search in this area"}
              </Button>
            </div>
          ) : null}

          {/* Controls: what NAVIGATES AWAY goes behind the overflow menu, what
              ACTS ON THE MAP is a column of identical round buttons. They carry
              no visible label; `aria-label` supplies both the accessible name
              and the tooltip text, so there is one string and no way to
              translate one side only. See `.tooltip` in `globals.css`. */}
          <div className="map__tools">
            <div className="map__controls">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="menu__trigger tooltip tooltip--left"
                    aria-label="Settings and account"
                  >
                    <Ellipsis className="menu__icon" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* The queried activities are set BEFORE a survey and open
                      a long panel below, in the tool column; the menu only
                      triggers it, then closes to let it be read. */}
                  <DropdownMenuItem
                    aria-expanded={toolsOpen}
                    onClick={() => setToolsOpen((open) => !open)}
                  >
                    Sector settings
                  </DropdownMenuItem>

                  {/* The price grid drives every amount on this screen, but
                      it lives on its own page: the sector settings change
                      before each survey, the grid a few times a year. */}
                  <DropdownMenuItem asChild>
                    <Link href={"/pricing" as Route}>Pricing</Link>
                  </DropdownMenuItem>

                  <DropdownMenuItem asChild>
                    <Link href={"/onboarding" as Route}>Setup</Link>
                  </DropdownMenuItem>

                  {/* Only on the hosted service: self-hosted has no plan to
                      manage, and the quota prop is its own billing switch. */}
                  {cumulativeAreaKm2 !== null ? (
                    <DropdownMenuItem asChild>
                      <Link href={"/billing" as Route}>Billing</Link>
                    </DropdownMenuItem>
                  ) : null}

                  {/* The label names the DESTINATION, never the current
                      state: in a list, "Dark" alone reads as the state you
                      are already in. */}
                  <DropdownMenuItem onClick={() => toggleTheme()}>
                    {themeDescription}
                  </DropdownMenuItem>

                  {/* The map is where the day is spent, and on a shared
                      machine an unreachable sign-out leaves the whole
                      prospecting file open behind you. */}
                  <AccountMenu account={account} />
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Drawing a sector is the founding gesture and the only control
                  here that changes colour, because it is the only one that
                  carries a state (`aria-pressed`). */}
              <button
                type="button"
                className="map__control tooltip tooltip--left"
                aria-pressed={drawMode}
                aria-label={drawMode ? "Cancel the drawing (Esc)" : "Draw a sector"}
                onClick={() => {
                  setDrawRefusal(null);
                  setDrawMode((mode) => !mode);
                }}
              >
                <DrawIcon />
              </button>

              <button
                type="button"
                className="map__control map__rail-toggle tooltip tooltip--left"
                aria-pressed={railOpen}
                aria-label={railOpen ? "Close the side panel" : "Open the side panel"}
                onClick={() => setRailOpen((open) => !open)}
              >
                <PanelIcon />
              </button>
            </div>

            {drawMode ? (
              /* Built as one template literal, never as multi-line JSX: the
                 compiler collapses the space after a closing brace when the
                 text continues on the next line, turning "12 km²" into
                 "12km²" with no warning. */
              <p className="t-body-s map__hint">
                {cumulativeAreaKm2 !== null
                  ? `Drag to draw a rectangle. ${MAX_ZONE_AREA_KM2} km² per sector, ${MAX_CUMULATIVE_AREA_KM2} km² total per month (${formatNumber(cumulativeAreaKm2.km2, 1)} km² already surveyed).`
                  : `Drag to draw a rectangle. ${MAX_ZONE_AREA_KM2} km² at most, or the API saturates its 10 000 results and returns an incomplete sector without saying so.`}
              </p>
            ) : null}

            {drawRefusal ? (
              <p className="t-body-s map__refusal" role="alert">
                {drawRefusal}
              </p>
            ) : null}

            {toolsOpen ? (
              <div className="map__settings panel">
                <Badge asChild><h3>Activities queried</h3></Badge>
                <ul className="map__naf">
                  {naf.map((activity) => {
                    const check = chosenNaf.includes(activity.code);
                    return (
                      <li key={activity.code}>
                        <label className="map__naf-row">
                          <input
                            type="checkbox"
                            checked={check}
                            onChange={() =>
                              setChosenNaf((list) =>
                                check
                                  ? list.filter((code) => code !== activity.code)
                                  : [...list, activity.code],
                              )
                            }
                          />
                          <span className="t-mono map__naf-code">{activity.code}</span>
                          <span className="t-body-s">{activity.label}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>

                <label className="map__field">
                  <Badge>Sector name</Badge>
                  <input
                    className="map__input"
                    value={sectorName}
                    onChange={(event) => setSectorName(event.target.value)}
                    placeholder="Centre-ville"
                    maxLength={120}
                  />
                </label>

                <Button
                  variant="secondary"
                  size="compact"
                  disabled={enrichPending || enrichLoop}
                  onClick={startEnrichment}
                >
                  {enrichLoop ? "Enriching…" : "Enrich this frame"}
                </Button>
                <p className="t-body-s tone-3">
                  Google first, then the in-house site audit. Enrichment needs a
                  Google Places key — add one on the Setup screen, or set
                  GOOGLE_PLACES_API_KEY. Google is the only source of a website
                  address, and the audit has nothing to read without one. It advances
                  nobody — it only adds facts.
                </p>
              </div>
            ) : null}
          </div>

          {surveyRun || surveyPending || (surveyState.message && !surveyDismissed) ? (
            <div className="map__work panel" role="status" aria-live="polite">
              <Badge asChild>
                <h3>
                  {surveyLoop || surveyPending ? "Survey running" : "Survey"}
                </h3>
              </Badge>

              {surveyRun ? (
                <>
                  <p className="t-body tnum">
                    Page {surveyRun.page}
                    {estimatedPages ? ` of ~${estimatedPages}` : ""} · {surveyRun.found}{" "}
                    businesses read · {surveyRun.created} new
                  </p>
                  <Gauge
                    value={surveyProgress}
                    tint="var(--accent)"
                    valueText={percent(surveyProgress * 100)}
                    name="Progress"
                  />
                  <p className="t-body-s tone-2 tnum">
                    {surveyRun.requests} calls made
                    {surveyRun.outsidePolygon > 0
                      ? ` · ${surveyRun.outsidePolygon} outside the drawn shape`
                      : ""}
                  </p>
                  {surveyRun.saturated ? (
                    <p className="t-body-s map__refusal">
                      The sector saturates the API’s 10 000 results: some are missing,
                      and we do not know how many. Cut it smaller.
                    </p>
                  ) : null}
                  {surveyRun.truncated ? (
                    <p className="t-body-s map__refusal">
                      A ceiling cut the survey short: businesses are missing.
                    </p>
                  ) : null}
                </>
              ) : null}

              {surveyState.message && !surveyDismissed ? (
                <p className="t-body" data-status={surveyState.status}>
                  {surveyState.message}
                </p>
              ) : null}

              <div className="map__work-actions">
                {surveyLoop ? (
                  <Button
                    variant="quiet"
                    size="compact"
                    onClick={() => {
                      stopSurvey.current = true;
                      setSurveyLoop(false);
                    }}
                  >
                    Stop
                  </Button>
                ) : null}
                {!surveyLoop && surveyRun && surveyRun.nextPage !== null ? (
                  <Button variant="primary" size="compact" onClick={resumeSurvey}>
                    Resume page {surveyRun.nextPage}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {enrichment || enrichState.message ? (
            <div className="map__work panel" role="status" aria-live="polite">
              <Badge asChild><h3>Enrichment</h3></Badge>
              {enrichment ? (
                <p className="t-body tnum">
                  {enrichment.enriched} enriched · {enrichment.remaining}{" "}
                  remaining
                  {enrichment.unreachable > 0
                    ? ` · ${enrichment.unreachable} with nothing to query`
                    : ""}
                  {enrichment.purged > 0
                    ? ` · ${enrichment.purged} purged (30 days)`
                    : ""}
                </p>
              ) : null}
              {enrichState.message ? (
                <p className="t-body" data-status={enrichState.status}>
                  {enrichState.message}
                </p>
              ) : null}
              {enrichLoop ? (
                <Button
                  variant="quiet"
                  size="compact"
                  onClick={() => {
                    stopEnrich.current = true;
                    setEnrichLoop(false);
                  }}
                >
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Rows span the whole territory: without a sector selected, the map has no matching point to anchor a tooltip on. */}
          {sectorHere ? (
            <DailyFront
              rows={front}
              selectedId={selectedId}
              onSelect={select}
              className="map__front"
            />
          ) : null}

          <Hold
            captures={stats.countByState.taken}
            surveyed={stats.total}
            sector={nameHere}
            floating
            className="map__hold"
          />

          {/* The preview sits over the canvas, in the same container, because
              that is the container `project()` returns coordinates for. Moving
              it out — into the shell or a portal — would offset the card by the
              rail height with every calculation still correct. */}
          {detail && anchor && !fallback ? (
            <FloatingSheet
              detail={detail}
              anchor={anchor}
              width={container.current?.clientWidth ?? 0}
              onOpen={() => setSheetOpen(true)}
              onClose={() => select(null)}
            />
          ) : null}

          {drawing ? (
            <span className="sr-only" role="status">
              Drawing. Esc to cancel.
            </span>
          ) : null}
        </div>
      </div>

      {/* The full sheet opens on demand only — except without a map, where the
          floating preview has nothing to anchor to and the list is the only
          route to a business. */}
      {detail && recordOpen ? (
        <TargetSheet
          detail={detail}
          outcomeCount={outcomeCount}
          // Falls back to the floating preview, not a full deselect — except
          // without a map, which has no preview to fall back to.
          onClose={() => (fallback ? select(null) : setSheetOpen(false))}
          onSelect={select}
        />
      ) : null}

    </div>
  );
}

// The control icons are drawn in-repo: a typographic glyph is redrawn by every
// platform and at 18 px inside a 44 px circle it usually reads as a smudge.
// `currentColor` only — a coloured mark would be the sole tint in this corner.
function DrawIcon() {
  return (
    <svg
      className="map__control-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The dashed frame, open at the bottom right where the pen crosses: a
          solid line under the nib would read as a strike-through. The pen and
          the rectangle both matter — together they say "draw a frame", which is
          exactly what appears on the map while dragging. */}
      <path d="M4 9.5V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v4" strokeDasharray="3 2.4" />
      <path d="M4 13.5v5A1.5 1.5 0 0 0 5.5 20h5" strokeDasharray="3 2.4" />
      <path d="m20.2 12.1-6.4 6.4-3 .8.8-3 6.4-6.4a1.55 1.55 0 0 1 2.2 2.2Z" />
      <path d="m17.6 13.3 1.6 1.6" />
    </svg>
  );
}

/** The side rail: a frame with its filled column. */
function PanelIcon() {
  return (
    <svg
      className="map__control-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M9.5 5v14" />
      <path d="M3.5 5h6v14h-6z" fill="currentColor" stroke="none" opacity="0.28" />
    </svg>
  );
}
