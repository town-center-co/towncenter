// `force-dynamic` is mandatory: without it Next prerenders this page at build
// time and the HTML freezes the database state, invisibly in `next dev`.
// `PageProps<"/">` only exists after `next typegen`, which runs before `tsc`.

import {
  getClusters,
  getCumulativeAreaKm2,
  getPriceGrid,
  getTargetDetail,
  getZoneStats,
  listFront,
  listTargetsInBbox,
  listZones,
} from "@/app/queries";
import { TerritoryMap, type NafOption } from "@/components/map/TerritoryMap";
import { requireUser } from "@/lib/accounts";
import { DEFAULT_FRAME, frameToText, textToFrame } from "@/components/map/frame";
import { parseView } from "@/components/map/view";
import { unionBbox } from "@/lib/geo";
import { standardDealCents } from "@/lib/priceGrid";
import {
  SIRENE_EXTRA_NAF,
  SIRENE_MAX_PER_PAGE,
  SIRENE_TARGET_NAF,
} from "@/lib/sources/sirene";

import "@/components/map/map.css";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// checked before the query: an arbitrary string off the address bar has no
// business reaching a `where`. refused here, the screen opens with no record.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAF: NafOption[] = [...SIRENE_TARGET_NAF, ...SIRENE_EXTRA_NAF].map((target) => ({
  code: target.code,
  label: target.label,
}));

const DEFAULT_NAF: string[] = SIRENE_TARGET_NAF.map((target) => target.code);

export default async function Page(props: PageProps<"/">) {
  // the owner bounds EVERY read below, and is read first.
  const owner = await requireUser();

  const params = await props.searchParams;

  const requestedFrame = textToFrame(first(params.frame));

  // With no frame in the URL — a bare `/` visit — the default view should be
  // the user's own territory, not a hardcoded city; that needs the sector
  // list before `frame` is known, so it's fetched ahead of the rest here.
  const earlySectors = requestedFrame ? null : await listZones(owner, 24);
  const frame =
    requestedFrame ??
    (earlySectors ? unionBbox(earlySectors.map((sector) => sector.bbox)) : null) ??
    DEFAULT_FRAME;
  const frameText = frameToText(frame);

  const requestedTarget = first(params.target);
  const targetId = requestedTarget && UUID_PATTERN.test(requestedTarget) ? requestedTarget : null;

  // Same rule as the target id above: `parseView` falls back to the default on
  // anything it does not recognise, so no hand-edited value reaches a `where`.
  const view = parseView({
    sort: first(params.sort),
    dir: first(params.dir),
    show: first(params.show),
  });

  // ensureGoogleRetention() runs from listTargetsInBbox and getTargetDetail
  // only: dropping either from this list drops the 30-day Google purge with it.
  const [
    inFrame,
    stats,
    sectors,
    front,
    grid,
    detail,
    cumulativeArea,
  ] = await Promise.all([
    listTargetsInBbox(owner, frame, {
      sort: view.sort,
      dir: view.dir,
      states: view.states,
    }),
    // NOT filtered, deliberately: this is the frame's own count, and a filter
    // that moved it would make the sector report something it does not hold.
    getZoneStats(owner, frame),
    earlySectors ? Promise.resolve(earlySectors) : listZones(owner, 24),
    listFront(owner, 5),
    getPriceGrid(owner),
    targetId ? getTargetDetail(owner, targetId) : Promise.resolve(null),
    process.env.MOLLIE_API_KEY
      ? getCumulativeAreaKm2(owner)
      : Promise.resolve(null),
  ]);

  // clustered in TypeScript, not SQL: the grouping depends on the expected
  // value, which is recomputed on read and exists in no column.
  const clusters = getClusters(inFrame.rows);

  return (
    <main className="territory">
      <TerritoryMap
        account={owner}
        frame={frame}
        frameText={frameText}
        view={view}
        targets={inFrame.rows}
        total={inFrame.total}
        truncated={inFrame.truncated}
        outcomeCount={inFrame.outcomeCount}
        clusters={clusters}
        sectors={sectors}
        front={front}
        stats={stats}
        standardDealCents={standardDealCents(grid)}
        detail={detail}
        cumulativeAreaKm2={cumulativeArea}
        naf={NAF}
        defaultNaf={DEFAULT_NAF}
        fichesParPage={SIRENE_MAX_PER_PAGE}
      />
    </main>
  );
}
