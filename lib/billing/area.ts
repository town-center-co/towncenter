import "server-only";

import { and, eq, gte } from "drizzle-orm";

import { db, zones } from "@/lib/db";
import { areaKm2 } from "@/lib/geo";
import type { Bbox } from "@/lib/types";

type AreaReader = Pick<typeof db, "select">;

export async function getCumulativeAreaKm2(
  ownerId: string,
  since: Date | null,
  reader: AreaReader = db,
): Promise<number> {
  const rows = await reader
    .select({ bbox: zones.bbox })
    .from(zones)
    .where(
      since
        ? and(eq(zones.ownerId, ownerId), gte(zones.startedAt, since))
        : eq(zones.ownerId, ownerId),
    );
  return rows.reduce((sum, row) => sum + areaKm2(row.bbox as Bbox), 0);
}
