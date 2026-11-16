// Fictional demo sources (ported unchanged from Stage 1 server/checklah/connectors/demo.py).
// Every name, identifier, role and listing is invented: IDs carry demo namespaces and DEMO- prefixes,
// UENs use the impossible year "99" (T99DM...), domains use reserved .example/.test TLDs.

import data from "./demo-data.json" with { type: "json" };
import type { SourceRecord } from "./records.ts";
import type { Prepared } from "./lifecycle.ts";

type Raw = Omit<SourceRecord, "context">;

export const DEMO_SOURCES = ["demo-watchlist", "demo-registry", "demo-webfeed"] as const;

export function demoPrepared(source: (typeof DEMO_SOURCES)[number], opts: { withProbes?: boolean; now?: number } = {}): Prepared {
  const d = data as unknown as Record<string, Raw[]>;
  const rows: Raw[] = source === "demo-watchlist" ? [...d.watchlist, ...(opts.withProbes ? d.probes : [])]
    : source === "demo-registry" ? d.registry : d.webfeed;
  const now = opts.now ?? Date.now();
  const exported = source === "demo-webfeed" ? now - 10 * 86400_000 : now - 3 * 3600_000;
  return {
    upstream: { version: `demo-${new Date(now).toISOString().slice(0, 10)}`, exportAt: new Date(exported).toISOString(), checksum: null },
    scope: { demo: true },
    async *records() {
      for (const r of rows) yield structuredClone(r) as SourceRecord;
    },
  };
}
