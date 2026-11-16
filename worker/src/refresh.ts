// Daily refresh POLICY (what is due), separate from execution. Disabled in production until
// deployment approval: no cron trigger is configured and REFRESH_ENABLED defaults to "false".
//
// - ACRA: monthly upstream. Check once a day; import only when the upstream version/checksum or the
//   normalized content differs (unchanged -> no data writes, only checked_at).
// - OpenSanctions: upstream republishes ~every 6 h. App policy: at most one fetch per 24 h; the
//   adapter refuses anything more frequent than 6 h regardless of configuration.

import type { Db } from "./db.ts";
import { SOURCES, type Mode } from "./sources.ts";

export const POLICY: Record<string, { checkEveryHours: number; minFetchIntervalHours: number }> = {
  acra: { checkEveryHours: 24, minFetchIntervalHours: 24 },
  opensanctions: { checkEveryHours: 24, minFetchIntervalHours: 6 },
};

export interface Due { source: string; reason: string }

export function isDue(source: string, checkedAt: string | null, now = Date.now()): Due | null {
  const p = POLICY[source];
  if (!p) return null;
  if (!checkedAt) return { source, reason: "never checked" };
  const age = (now - Date.parse(checkedAt)) / 3600_000;
  if (!(age >= 0)) return { source, reason: "invalid checked_at" };
  return age >= p.checkEveryHours ? { source, reason: `last checked ${age.toFixed(1)} h ago` } : null;
}

/** Hard floor: refuse to refetch the full OpenSanctions export more often than every 6 hours. */
export function fetchAllowed(source: string, lastAttemptAt: string | null, now = Date.now()): boolean {
  const p = POLICY[source];
  if (!p || !lastAttemptAt) return true;
  return (now - Date.parse(lastAttemptAt)) / 3600_000 >= p.minFetchIntervalHours;
}

export async function dueChecks(db: Db, mode: Mode, now = Date.now()): Promise<Due[]> {
  if (mode !== "live") return [];
  const rows = await db.prepare("SELECT id, checked_at FROM sources").all<{ id: string; checked_at: string | null }>();
  const map = new Map(rows.results.map(r => [r.id, r.checked_at]));
  return SOURCES.filter(s => s.mode === "live" && s.adapter && s.adapter !== "demo")
    .flatMap(s => { const d = isDue(s.id, map.get(s.id) ?? null, now); return d ? [d] : []; });
}
